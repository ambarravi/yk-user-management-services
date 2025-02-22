import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";

import { v4 as uuidv4 } from "uuid";

const ddbClient = new DynamoDBClient({ region: "eu-west-1" });

export const handler = async (event) => {
  console.log("Received event:", event);
  try {
    const requestBody = JSON.parse(event.body);
    const { eventId, userId, rating, comment, mood } = requestBody;

    // Validate input
    if (!eventId || !userId || !rating || rating < 1 || rating > 5) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "Invalid feedback details." }),
      };
    }

    const feedbackID = uuidv4();
    const submittedAt = Math.floor(Date.now() / 1000); // Unix timestamp

    // Step 1: Check if feedback already exists for this user and event
    const existingFeedback = await ddbClient.send(
      new QueryCommand({
        TableName: "EventFeedback",
        KeyConditionExpression: "EventID = :eventId AND UserID = :userId",
        ExpressionAttributeValues: {
          ":eventId": { S: eventId },
          ":userId": { S: userId },
        },
      })
    );

    if (existingFeedback.Count > 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: "Feedback already submitted for this event.",
        }),
      };
    }

    // Step 2: Check if booking exists and feedback hasn't been submitted
    const bookingCheck = await ddbClient.send(
      new QueryCommand({
        TableName: "BookingDetails",
        IndexName: "UserId-EventID-index", // Assuming this GSI exists
        KeyConditionExpression: "EventID = :eventId AND UserId = :userId",
        FilterExpression: "BookingStatus = :completedStatus",
        ExpressionAttributeValues: {
          ":eventId": { S: eventId },
          ":userId": { S: userId },
          ":completedStatus": { S: "Completed" },
        },
      })
    );

    if (bookingCheck.Count === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          message: "No completed booking found for this event.",
        }),
      };
    }

    const booking = bookingCheck.Items[0];
    if (booking.FeedbackSubmitted?.BOOL === true) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: "Feedback already submitted for this booking.",
        }),
      };
    }

    const bookingID = booking.BookingID.S;

    // Step 3: Perform transaction to store feedback and update booking
    const transactionCommand = new TransactWriteItemsCommand({
      TransactItems: [
        // Store feedback in EventFeedback table
        {
          Put: {
            TableName: "EventFeedback",
            Item: {
              EventID: { S: eventId },
              UserID: { S: userId },
              FeedbackID: { S: feedbackID },
              Rating: { N: rating.toString() },
              Comment: comment ? { S: comment } : { S: "" },
              Mood: mood ? { S: mood } : { S: "neutral" },
              SubmittedAt: { N: submittedAt.toString() },
            },
            ConditionExpression: "attribute_not_exists(EventID)", // Prevent overwrite
          },
        },
        // Update BookingDetails with FeedbackSubmitted flag
        {
          Update: {
            TableName: "BookingDetails",
            Key: { BookingID: { S: bookingID } },
            UpdateExpression: "SET FeedbackSubmitted = :true",
            ConditionExpression:
              "attribute_not_exists(FeedbackSubmitted) OR FeedbackSubmitted = :false",
            ExpressionAttributeValues: {
              ":true": { BOOL: true },
              ":false": { BOOL: false },
            },
          },
        },
      ],
    });

    await ddbClient.send(transactionCommand);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Feedback submitted successfully",
        feedbackID: feedbackID,
      }),
    };
  } catch (error) {
    console.error("Error processing feedback:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Internal server error",
        error: error.message,
      }),
    };
  }
};
