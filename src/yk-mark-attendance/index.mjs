import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({ region: process.env.AWS_REGION });

// Reusable CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "OPTIONS,POST",
};

// Helper function to create error responses
const createErrorResponse = (
  statusCode,
  errorCode,
  errorMessage,
  details = {}
) => ({
  statusCode,
  headers: corsHeaders,
  body: JSON.stringify({
    errorCode,
    errorMessage,
    details,
  }),
});

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { bookingId, eventId } = body;

    // Validate input parameters
    if (!bookingId || !eventId) {
      return createErrorResponse(
        400,
        "MISSING_FIELDS",
        "Missing required fields: bookingId and/or eventId",
        {
          missingFields: [
            !bookingId ? "bookingId" : null,
            !eventId ? "eventId" : null,
          ].filter(Boolean),
        }
      );
    }

    // Get booking details from DynamoDB
    const getBookingParams = {
      TableName: "BookingDetails",
      Key: {
        BookingID: { S: bookingId },
      },
    };

    const bookingData = await client.send(new GetItemCommand(getBookingParams));

    // Check if booking exists
    if (!bookingData.Item) {
      console.log("No booking found for the provided bookingId.");

      return createErrorResponse(
        404,
        "BOOKING_NOT_FOUND",
        "No booking found for the provided bookingId."
      );
    }

    const booking = bookingData.Item;

    // Validate EventID match
    if (booking.EventID.S !== eventId) {
      console.log("The provided eventId does not match the booking.");

      return createErrorResponse(
        400,
        "EVENT_MISMATCH",
        "The provided eventId does not match the booking."
      );
    }

    // Validate BookingStatus
    if (booking.BookingStatus.S !== "Completed") {
      console.log(
        "Cannot mark attendance. Booking status is ${booking.BookingStatus.S}."
      );

      return createErrorResponse(
        400,
        "INVALID_BOOKING_STATUS",
        `Cannot mark attendance. Booking status is ${booking.BookingStatus.S}.`,
        {
          currentStatus: booking.BookingStatus.S,
        }
      );
    }

    // Validate MarkAttendance
    if (booking.MarkAttendance?.BOOL === true) {
      console.log("Attendance has already been marked for this booking.");

      return createErrorResponse(
        400,
        "ATTENDANCE_ALREADY_MARKED",
        "Attendance has already been marked for this booking."
      );
    }

    // Get UserID from booking
    const userId = booking.UserID?.S;
    if (!userId) {
      console.log("Booking does not contain a valid UserID.");
      return createErrorResponse(
        400,
        "INVALID_BOOKING",
        "Booking does not contain a valid UserID."
      );
    }

    // Update MarkAttendance in BookingDetails
    const updateBookingParams = {
      TableName: "BookingDetails",
      Key: {
        BookingID: { S: bookingId },
      },
      UpdateExpression: "SET MarkAttendance = :attendance",
      ExpressionAttributeValues: {
        ":attendance": { BOOL: true },
      },
    };

    await client.send(new UpdateItemCommand(updateBookingParams));

    // Update eventsAttended in UsersTable
    const updateUserParams = {
      TableName: "UsersTable",
      Key: {
        UserID: { S: userId },
      },
      UpdateExpression:
        "SET eventsAttended = if_not_exists(eventsAttended, :zero) + :increment",
      ExpressionAttributeValues: {
        ":zero": { N: "0" },
        ":increment": { N: "1" },
      },
    };

    await client.send(new UpdateItemCommand(updateUserParams));

    // Update TotalAttendance in EventDetails
    const updateEventParams = {
      TableName: "EventDetails",
      Key: {
        EventID: { S: eventId },
      },
      UpdateExpression:
        "SET TotalAttendance = if_not_exists(TotalAttendance, :zero) + :increment",
      ExpressionAttributeValues: {
        ":zero": { N: "0" },
        ":increment": { N: "1" },
      },
    };

    await client.send(new UpdateItemCommand(updateEventParams));

    // Return success response
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success: true,
        message: `Attendance marked successfully for bookingId: ${bookingId}`,
      }),
    };
  } catch (error) {
    console.error("Error processing booking attendance:", error);
    return createErrorResponse(
      500,
      "SERVER_ERROR",
      "An unexpected error occurred while processing your request.",
      {
        errorDetails: error.message,
      }
    );
  }
};
