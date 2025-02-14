import {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";

const ddbClient = new DynamoDBClient({ region: "eu-west-1" });

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

    // Step 2: Update BookingStatus and Adjust SeatsBooked in EventDetails
    const transactionCommand = new TransactWriteItemsCommand({
      TransactItems: [
        // Update Booking Status to "Cancelled"
        {
          Update: {
            TableName: "BookingDetails",
            Key: { BookingID: { S: bookingID } },
            UpdateExpression: "SET BookingStatus = :cancelledStatus",
            ExpressionAttributeValues: {
              ":cancelledStatus": { S: "Cancelled" },
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
      body: JSON.stringify({ message: "Booking cancelled successfully." }),
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
