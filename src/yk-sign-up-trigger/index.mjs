import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

// Use the region from the environment variable
const region = process.env.AWS_REGION || "eu-west-1"; // Default to us-east-1 if not set
const dynamoDB = new DynamoDBClient({ region });

const USERS_TABLE = "UsersTable"; // Replace with your table name

export const handler = async (event) => {
  console.log("Event received from Cognito:", JSON.stringify(event, null, 2));

  try {
    const { sub: UserID, email, given_name: FirstName, family_name: LastName, phone_number: Mobile } = event.request.userAttributes;

    if (!UserID) {
      throw new Error("Missing UserID (sub) from Cognito attributes");
    }

    const updateParams = {
      TableName: USERS_TABLE,
      Key: { UserID },
      UpdateExpression: `
        SET #email = :email,
            #firstName = :firstName,
            #lastName = :lastName,
            #mobile = :mobile,
            #createdAt = :createdAt
      `,
      ExpressionAttributeNames: {
        "#email": "Email",
        "#firstName": "FirstName",
        "#lastName": "LastName",
        "#mobile": "Mobile",
        "#createdAt": "CreatedAt",
      },
      ExpressionAttributeValues: {
        ":email": email || "N/A",
        ":firstName": FirstName || "N/A",
        ":lastName": LastName || "N/A",
        ":mobile": Mobile || "N/A",
        ":createdAt": new Date().toISOString(),
      },
      ReturnValues: "ALL_NEW",
    };

    console.log("Update parameters:", JSON.stringify(updateParams, null, 2));

    const command = new UpdateCommand(updateParams);
    const result = await dynamoDB.send(command);

    console.log("DynamoDB update result:", JSON.stringify(result, null, 2));

    return event; // Return the original event for Cognito
  } catch (error) {
    console.error("Error updating DynamoDB:", error.message);
    throw new Error(`Post-confirmation trigger failed: ${error.message}`);
  }
};
