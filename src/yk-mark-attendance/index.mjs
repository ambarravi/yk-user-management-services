import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({ region: "us-east-1" });

// Reusable CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "OPTIONS,POST",
};

export const handler = async (event) => {
  try {
    // Extract input parameters
    const { bookingID, eventID } = event;

    // Validate input parameters
    if (!bookingID || !eventID) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          errorCode: "Bad Request - 400",
          errorMessage: "Missing required fields: bookingID or eventID",
        }),
      };
    }

    // Get booking details from DynamoDB
    const getItemParams = {
      TableName: "BookingDetails",
      Key: {
        BookingID: { S: bookingID },
      },
    };

    const bookingData = await client.send(new GetItemCommand(getItemParams));

    // Check if booking exists
    if (!bookingData.Item) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          errorCode: "Bad Request - 400",
          errorMessage: "Event details do not match the booking record.",
        }),
      };
    }

    const booking = bookingData.Item;

    // Validate EventID match
    if (booking.EventID.S !== eventID) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          errorCode: "Bad Request - 400",
          errorMessage: "Event details do not match the booking record.",
        }),
      };
    }

    // Validate BookingStatus
    if (booking.BookingStatus.S !== "Completed") {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          errorCode: "Bad Request - 400",
          errorMessage:
            "This booking is not valid for attendance. It may have been canceled.",
        }),
      };
    }

    // Validate MarkAttendance
    if (booking.MarkAttendance && booking.MarkAttendance.BOOL === true) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          errorCode: "Bad Request - 400",
          errorMessage: "Attendance has already been marked for this booking.",
        }),
      };
    }

    // Update MarkAttendance in DynamoDB
    const updateItemParams = {
      TableName: "BookingDetails",
      Key: {
        BookingID: { S: bookingID },
      },
      UpdateExpression: "SET MarkAttendance = :attendance",
      ExpressionAttributeValues: {
        ":attendance": { BOOL: true },
      },
    };

    await client.send(new UpdateItemCommand(updateItemParams));

    // Return success response
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success: true,
      }),
    };
  } catch (error) {
    console.error("Error processing booking attendance:", error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        errorCode: "Internal Server Error - 500",
        errorMessage: "An error occurred while processing the request.",
      }),
    };
  }
};
