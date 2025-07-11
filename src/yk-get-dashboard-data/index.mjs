import {
  DynamoDBClient,
  ScanCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const client = new DynamoDBClient({
  region: process.env.AWS_REGION || "eu-west-1",
});

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const orgID = body.orgID;

    if (!orgID) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "orgID is required" }),
      };
    }

    // 1. Query EventDetails for this OrgID
    const eventCommand = new QueryCommand({
      TableName: "EventDetails",
      IndexName: "OrgID-index",
      KeyConditionExpression: "OrgID = :orgID",
      ExpressionAttributeValues: {
        ":orgID": { S: orgID },
      },
    });

    const eventResponse = await client.send(eventCommand);
    const eventItems = eventResponse.Items.map(unmarshall);

    // Aggregate event data
    const now = new Date();
    let totalSeatsBooked = 0;
    let totalSeatsAvailable = 0;
    let totalEngagement = 0;
    const futureEvents = [];
    const popularLabels = [];
    const popularData = [];
    const eventDates = [];

    for (const event of eventItems) {
      const booked = parseInt(event.SeatsBooked || 0);
      const total = parseInt(event.Seats || 0);
      totalSeatsBooked += booked;
      totalSeatsAvailable += total - booked;
      totalEngagement += booked;

      // Popular chart
      popularLabels.push(event.EventTitle);
      popularData.push(booked);

      // Future events
      if (event.EventDate) {
        const date = new Date(event.EventDate);
        if (date >= now) {
          futureEvents.push({
            ...event,
            date,
            readableDate: date.toLocaleDateString("en-GB", {
              day: "numeric",
              month: "long",
              year: "numeric",
            }),
          });
          eventDates.push(date);
        }
      }
    }

    // Sort upcoming events
    futureEvents.sort((a, b) => a.date - b.date);
    const upcomingEventsList = futureEvents.slice(0, 5).map((e) => ({
      title: e.EventTitle,
      date: e.readableDate,
    }));

    const upcomingEvent = futureEvents[0]
      ? {
          title: futureEvents[0].EventTitle,
          date: futureEvents[0].readableDate,
          image: futureEvents[0]?.EventImages?.[0],
        }
      : null;

    // 2. Feedback Query (all feedbacks for this org's events)
    const eventIDs = eventItems.map((e) => e.EventID);
    const feedbackList = [];

    for (const eventID of eventIDs) {
      const feedbackCommand = new QueryCommand({
        TableName: "EventFeedback",
        KeyConditionExpression: "EventID = :eventID",
        ExpressionAttributeValues: {
          ":eventID": { S: eventID },
        },
      });

      const feedbackResponse = await client.send(feedbackCommand);
      const feedbacks = feedbackResponse.Items.map(unmarshall);

      feedbacks.forEach((fb) => {
        if (fb.Comment?.trim()) {
          const event = eventItems.find((e) => e.EventID === eventID);
          if (event) {
            feedbackList.push({
              comment: fb.Comment,
              event: `${event.EventTitle} - ${new Date(
                event.EventDate
              ).toLocaleDateString("en-GB")}`,
            });
          }
        }
      });
    }

    // 3. Ratings Breakdown
    const ratingCounts = [0, 0, 0, 0, 0]; // 5 to 1
    feedbackList.forEach((fb) => {
      const rating = parseInt(fb.Rating || 0);
      if (rating >= 1 && rating <= 5) ratingCounts[5 - rating]++;
    });

    const result = {
      totalEvents: eventItems.length,
      totalFollowers: 0, // Not available yet from UserOrganizationFollow
      totalEngagement,
      ticketSales: {
        labels: ["Sold", "Available"],
        data: [totalSeatsBooked, totalSeatsAvailable],
      },
      eventDates,
      upcomingEvent,
      upcomingEventsList,
      popularEvents: {
        labels: popularLabels,
        data: popularData,
      },
      eventRatings: {
        labels: ["5 Stars", "4 Stars", "3 Stars", "2 Stars", "1 Star"],
        data: ratingCounts,
      },
      feedback: feedbackList,
      recentBookings: upcomingEventsList, // Same as upcomingEventsList for now
    };

    return {
      statusCode: 200,
      body: JSON.stringify(result),
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    };
  } catch (err) {
    console.error("Error generating dashboard data", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to process dashboard data" }),
    };
  }
};
