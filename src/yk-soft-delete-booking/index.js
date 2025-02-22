import {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";

const ddbClient = new DynamoDBClient({ region: "eu-west-1" });

export const softDeleteHandler = async (event) => {
  try {
    const requestBody = JSON.parse(event.body);
    const { bookingId } = requestBody;

    if (!bookingId) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: "Invalid input. BookingID is required.",
        }),
      };
    }

    await ddbClient.send(
      new UpdateItemCommand({
        TableName: "BookingDetails",
        Key: { BookingID: { S: bookingId } },
        UpdateExpression: "SET IsDeleted = :isDeleted",
        ConditionExpression: "BookingStatus = :cancelledStatus",
        ExpressionAttributeValues: {
          ":isDeleted": { BOOL: true },
          ":cancelledStatus": { S: "Cancelled" },
        },
      })
    );

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Booking marked for deletion." }),
    };
  } catch (error) {
    console.error("Error processing soft delete:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Internal server error",
        error: error.message,
      }),
    };
  }
};
