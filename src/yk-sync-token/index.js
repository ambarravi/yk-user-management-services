// index.mjs (ES6 Module)
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

//const REGION = "your-region"; // e.g. "us-east-1"
const USERS_TABLE = "UsersTable";

const ddb = new DynamoDBClient({ region: process.env.AWS_REGION });

export const handler = async (event) => {
  for (const record of event.Records) {
    const eventName = record.eventName;
    const userId = record.dynamodb.Keys.userId.S;

    if (eventName === "INSERT" || eventName === "MODIFY") {
      const newToken = record.dynamodb.NewImage.token.S;

      try {
        // Check if user exists
        const userCheck = await ddb.send(
          new GetItemCommand({
            TableName: USERS_TABLE,
            Key: { UserID: { S: userId } },
            ProjectionExpression: "UserID",
          })
        );

        if (!userCheck.Item) {
          console.warn(`User not found in UsersTable: ${userId}`);
          continue;
        }

        // Update pushToken
        await ddb.send(
          new UpdateItemCommand({
            TableName: USERS_TABLE,
            Key: { UserID: { S: userId } },
            UpdateExpression: "SET pushToken = :token",
            ConditionExpression: "attribute_exists(UserID)",
            ExpressionAttributeValues: {
              ":token": { S: newToken },
            },
          })
        );

        console.log(`Updated token for user ${userId}`);
      } catch (err) {
        console.error(`Failed to update token for ${userId}`, err);
      }
    }

    if (eventName === "REMOVE") {
      try {
        await ddb.send(
          new UpdateItemCommand({
            TableName: USERS_TABLE,
            Key: { UserID: { S: userId } },
            UpdateExpression: "REMOVE pushToken",
            ConditionExpression: "attribute_exists(UserID)",
          })
        );

        console.log(`Removed token for user ${userId}`);
      } catch (err) {
        console.error(`Failed to remove token for ${userId}`, err);
      }
    }
  }
};
