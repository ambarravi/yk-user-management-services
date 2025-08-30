import {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });

export const handler = async (event) => {
  console.log(event);
  try {
    const requestBody = JSON.parse(event.body);
    const { eventId, userId } = requestBody;

    if (!eventId || !userId) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: "Invalid input. EventID and UserID are required.",
        }),
      };
    }

    // Step 1: Fetch the existing booking
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

    if (!existingBooking.Items || existingBooking.Items.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          message: "No active booking found for this event.",
        }),
      };
    }

    const booking = existingBooking.Items[0];
    const bookingID = booking.BookingID.S;
    const ticketCount = parseInt(booking.SeatsBooked.N);
    const eventDate = new Date(booking.EventDate.S);

    // Calculate TTL: Event date + 7 days in epoch seconds
    const ttlDate = new Date(eventDate);
    ttlDate.setDate(eventDate.getDate() + 7);
    const ttlTimestamp = Math.floor(ttlDate.getTime() / 1000);

    // Step 2: Update BookingStatus, set TTL and soft delete flag
    const transactionCommand = new TransactWriteItemsCommand({
      TransactItems: [
        // Update Booking Details
        {
          Update: {
            TableName: "BookingDetails",
            Key: { BookingID: { S: bookingID } },
            UpdateExpression:
              "SET BookingStatus = :cancelledStatus, IsDeleted = :isDeleted, #ttlAttr = :ttl",
            ExpressionAttributeNames: {
              "#ttlAttr": "TTL", // Alias for reserved keyword TTL
            },
            ExpressionAttributeValues: {
              ":cancelledStatus": { S: "Cancelled" },
              ":isDeleted": { BOOL: false },
              ":ttl": { N: ttlTimestamp.toString() },
            },
          },
        },
        // Decrease booked seats count in EventDetails
        {
          Update: {
            TableName: "EventDetails",
            Key: { EventID: { S: eventId } },
            UpdateExpression:
              "SET SeatsBooked = if_not_exists(SeatsBooked, :zero) - :count",
            ConditionExpression: "SeatsBooked >= :count",
            ExpressionAttributeValues: {
              ":zero": { N: "0" },
              ":count": { N: ticketCount.toString() },
            },
          },
        },
      ],
    });

    await ddbClient.send(transactionCommand);
    console.log("Booking cancelled successfully.");

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Booking cancelled successfully.",
        bookingId: bookingID,
      }),
    };
  } catch (error) {
    console.error("Error processing cancellation:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Internal server error",
        error: error.message,
      }),
    };
  }
};
