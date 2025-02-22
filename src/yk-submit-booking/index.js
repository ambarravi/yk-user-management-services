import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";

import { v4 as uuidv4 } from "uuid";

const ddbClient = new DynamoDBClient({ region: "eu-west-1" });

export const handler = async (event) => {
  console.log(event);
  try {
    const requestBody = JSON.parse(event.body);
    const {
      eventId,
      userId,
      bookingName,
      bookingEmail,
      ticketCount,
      ticketPrice,
      totalPrice,
      contactNumber,
      paymentMethod = "CASH",
    } = requestBody.bookingDetails;

    if (!eventId || !userId || !ticketCount || ticketCount <= 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "Invalid booking details." }),
      };
    }

    const bookingID = uuidv4();
    console.log("BookingID", bookingID);
    const createdAt = Math.floor(Date.now() / 1000);

    // Step 1: Check if the user already booked this event (existing functionality)
    const existingBooking = await ddbClient.send(
      new QueryCommand({
        TableName: "BookingDetails",
        IndexName: "UserId-EventID-index",
        KeyConditionExpression: "EventID = :eventId AND UserId = :userId",
        FilterExpression: "BookingStatus = :completedStatus",
        ExpressionAttributeValues: {
          ":eventId": { S: eventId },
          ":userId": { S: userId },
          ":completedStatus": { S: "Completed" },
        },
      })
    );

    if (existingBooking.Count > 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: "User has already booked this event.",
        }),
      };
    }

    // Step 2: Fetch Event Details (existing functionality)
    const eventDetails = await ddbClient.send(
      new GetItemCommand({
        TableName: "EventDetails",
        Key: { EventID: { S: eventId } },
      })
    );

    if (!eventDetails.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ message: "Event not found." }),
      };
    }

    const totalSeats = parseInt(eventDetails.Item.Seats.N);
    const reservedSeats = parseInt(eventDetails.Item.ReservedSeats.N);
    const bookedSeats = eventDetails.Item.SeatsBooked?.N
      ? parseInt(eventDetails.Item.SeatsBooked.N)
      : 0;

    // Step 3: Check Seat Availability (existing functionality)
    if (bookedSeats + ticketCount > totalSeats) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "Not enough seats available." }),
      };
    }

    // Step 4: Enhanced Transaction with UsersTable Update
    const transactionCommand = new TransactWriteItemsCommand({
      TransactItems: [
        // Update SeatsBooked in EventDetails (existing)
        {
          Update: {
            TableName: "EventDetails",
            Key: { EventID: { S: eventId } },
            UpdateExpression:
              "SET SeatsBooked = if_not_exists(SeatsBooked, :zero) + :count",
            ConditionExpression:
              "attribute_not_exists(SeatsBooked) OR SeatsBooked <= :remainingSeats",
            ExpressionAttributeValues: {
              ":zero": { N: "0" },
              ":count": { N: ticketCount.toString() },
              ":remainingSeats": { N: (totalSeats - ticketCount).toString() },
            },
          },
        },
        // Insert New Booking Record (existing)
        {
          Put: {
            TableName: "BookingDetails",
            Item: {
              BookingID: { S: bookingID },
              EventID: { S: eventId },
              UserId: { S: userId },
              OrganizerID: { S: eventDetails.Item.OrgID.S },
              BookingStatus: { S: "Completed" },
              BookingDate: { S: new Date().toISOString() },
              EventDate: { S: eventDetails.Item.EventDate.S },
              PaymentMethod: { S: paymentMethod },
              CreatedAt: { N: createdAt.toString() },
              SeatsBooked: { N: ticketCount.toString() },
              BookingName: { S: bookingName },
              BookingEmail: { S: bookingEmail },
              BookingContact: { S: contactNumber },
              TicketPrice: { N: ticketPrice.toString() },
              TotalAmountPaid: { N: totalPrice.toString() },
            },
          },
        },
        // New: Update UsersTable to increment eventsAttended
        {
          Update: {
            TableName: "UsersTable",
            Key: { UserID: { S: userId } },
            UpdateExpression:
              "SET eventsAttended = if_not_exists(eventsAttended, :zero) + :increment",
            ExpressionAttributeValues: {
              ":zero": { N: "0" },
              ":increment": { N: "1" },
            },
          },
        },
      ],
    });

    await ddbClient.send(transactionCommand);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Booking successful",
        bookingID: bookingID,
      }),
    };
  } catch (error) {
    console.error("Error processing booking:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Internal server error",
        error: error.message,
      }),
    };
  }
};

// New function to handle booking cancellation
export const cancelBookingHandler = async (event) => {
  try {
    const requestBody = JSON.parse(event.body);
    const { bookingId, eventId, userId, ticketCount } = requestBody;

    if (!bookingId || !eventId || !userId || !ticketCount) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "Invalid cancellation details." }),
      };
    }

    const transactionCommand = new TransactWriteItemsCommand({
      TransactItems: [
        // Update EventDetails to reduce SeatsBooked
        {
          Update: {
            TableName: "EventDetails",
            Key: { EventID: { S: eventId } },
            UpdateExpression: "SET SeatsBooked = SeatsBooked - :count",
            ConditionExpression: "SeatsBooked >= :count",
            ExpressionAttributeValues: {
              ":count": { N: ticketCount.toString() },
            },
          },
        },
        // Update BookingDetails status to Cancelled
        {
          Update: {
            TableName: "BookingDetails",
            Key: { BookingID: { S: bookingId } },
            UpdateExpression: "SET BookingStatus = :cancelled",
            ConditionExpression: "BookingStatus = :completed",
            ExpressionAttributeValues: {
              ":cancelled": { S: "Cancelled" },
              ":completed": { S: "Completed" },
            },
          },
        },
        // Reduce eventsAttended count in UsersTable
        {
          Update: {
            TableName: "UsersTable",
            Key: { UserID: { S: userId } },
            UpdateExpression:
              "SET eventsAttended = eventsAttended - :decrement",
            ConditionExpression: "eventsAttended >= :decrement",
            ExpressionAttributeValues: {
              ":decrement": { N: "1" },
            },
          },
        },
      ],
    });

    await ddbClient.send(transactionCommand);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Booking cancelled successfully",
      }),
    };
  } catch (error) {
    console.error("Error cancelling booking:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Internal server error",
        error: error.message,
      }),
    };
  }
};
