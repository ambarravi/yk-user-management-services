import {
  DynamoDBClient,
  UpdateItemCommand,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

export const handler = async (event) => {
  if (!event.body) {
    console.error("Missing request body");
    return {
      statusCode: 400,
      body: JSON.stringify({ message: "Request body is required" }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (err) {
    console.error("Invalid JSON in request body:", err);
    return {
      statusCode: 400,
      body: JSON.stringify({ message: "Invalid request payload" }),
    };
  }

  const eventId = body.eventId;
  if (!eventId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ message: "Missing eventId in payload" }),
    };
  }

  const region = process.env.AWS_REGION || "us-east-1";
  const ddbClient = new DynamoDBClient({ region });

  // Check current status in DynamoDB
  const getParams = {
    TableName: process.env.DYNAMODB_TABLE_NAME,
    Key: { EventID: { S: eventId } },
  };

  let currentStatus;
  try {
    const getResult = await ddbClient.send(new GetItemCommand(getParams));
    currentStatus = getResult.Item?.CertificateStatus?.S;
  } catch (err) {
    console.error("DynamoDB get error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Failed to retrieve event status" }),
    };
  }

  // If status is "Completed", skip DynamoDB update
  if (currentStatus === "Completed") {
    console.log(`Event ${eventId} already completed, skipping DynamoDB update`);
  } else {
    // Update to "Processing" if status is not found or not "Completed"
    const updateParams = {
      TableName: process.env.DYNAMODB_TABLE_NAME,
      Key: { EventID: { S: eventId } },
      UpdateExpression: "SET CertificateStatus = :status",
      ExpressionAttributeValues: { ":status": { S: "Processing" } },
      ConditionExpression:
        "attribute_exists(EventID) OR attribute_not_exists(CertificateStatus)",
    };

    try {
      await ddbClient.send(new UpdateItemCommand(updateParams));
      console.log(`Updated event ${eventId} status to Processing`);
    } catch (err) {
      console.error("DynamoDB update error:", err);
      return {
        statusCode: 500,
        body: JSON.stringify({ message: "Failed to update event status" }),
      };
    }
  }

  // Prepare SQS payload with status
  const sqsPayload = {
    ...body,
    certificateStatus: currentStatus || "Processing",
  };

  const sqsClient = new SQSClient({ region });
  const sqsParams = {
    QueueUrl: process.env.SQS_QUEUE_URL,
    MessageBody: JSON.stringify(sqsPayload),
  };

  try {
    await sqsClient.send(new SendMessageCommand(sqsParams));
    console.log(`Enqueued certificate request for event ${eventId}`);
  } catch (err) {
    console.error("SQS send error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Failed to enqueue request" }),
    };
  }

  return {
    statusCode: 202,
    body: JSON.stringify({ message: "Certificate request accepted" }),
  };
};
