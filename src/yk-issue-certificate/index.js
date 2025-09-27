const {
  DynamoDBClient,
  UpdateItemCommand,
} = require("@aws-sdk/client-dynamodb");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");

exports.handler = async (event) => {
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

  const ddbClient = new DynamoDBClient({});
  const updateParams = {
    TableName: process.env.DYNAMODB_TABLE_NAME,
    Key: { EventID: { S: eventId } },
    UpdateExpression: "SET CertificateStatus = :status",
    ExpressionAttributeValues: { ":status": { S: "Processing" } },
    ConditionExpression: "attribute_exists(EventID)", // Ensure item exists
  };

  try {
    await ddbClient.send(new UpdateItemCommand(updateParams));
  } catch (err) {
    console.error("DynamoDB update error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Failed to update event status" }),
    };
  }

  const sqsClient = new SQSClient({});
  const sqsParams = {
    QueueUrl: process.env.SQS_QUEUE_URL,
    MessageBody: event.body, // Pass original payload as is
  };

  try {
    await sqsClient.send(new SendMessageCommand(sqsParams));
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
