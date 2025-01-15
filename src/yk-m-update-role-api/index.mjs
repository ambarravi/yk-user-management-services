import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION;
const USER_POOL_ID = process.env.USER_POOL_ID;
const USERS_TABLE = process.env.USERS_TABLE;
const ROLE_CONFIG = process.env.ROLE_CONFIG?.split(",") || [
  "user",
  "organizer",
];

const dynamoDBClient = new DynamoDBClient({ region: REGION });
const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const {
      username,
      tempRole,
      "custom:role": currentRole,
      city,
      collegeDetails,
    } = body;

    if (!username || !tempRole || !currentRole || !city) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message:
            "Invalid input: username, tempRole, custom:role, and city are required.",
        }),
      };
    }

    let newRole;
    if (tempRole.toLowerCase() === currentRole.toLowerCase()) {
      return {
        statusCode: 200,
        body: JSON.stringify({ message: "Role is already updated" }),
      };
    } else {
      newRole = currentRole.toLowerCase() + "," + tempRole.toLowerCase();
    }

    const updatedAttributes = [
      {
        Name: "custom:role",
        Value: newRole,
      },
    ];

    await cognitoClient.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
        UserAttributes: updatedAttributes,
      })
    );

    const updateExpression = ["set #role = :role"];
    const expressionAttributeNames = { "#role": "role" };
    const expressionAttributeValues = { ":role": newRole };

    if (city) {
      updateExpression.push("#city = :city");
      expressionAttributeNames["#city"] = "city";
      expressionAttributeValues[":city"] = city;
    }

    if (collegeDetails) {
      updateExpression.push("#collegeDetails = :collegeDetails");
      expressionAttributeNames["#collegeDetails"] = "collegeDetails";
      expressionAttributeValues[":collegeDetails"] = collegeDetails;
    }

    await dynamoDBClient.send(
      new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { username },
        UpdateExpression: updateExpression.join(", "),
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
      })
    );

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Role updated successfully" }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Internal Server Error",
        error: error.message,
      }),
    };
  }
};
