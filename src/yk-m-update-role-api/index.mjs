import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
} from "@aws-sdk/client-cognito-identity-provider";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

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
  console.log("Event: ", JSON.stringify(event));

  try {
    //const body = JSON.parse(event.body);
    console.log("eventDetails: ", event);
    const { userName, userID, tempRole, currentRole, city, collegeDetails } =
      event;

    if (!userID || !tempRole || !currentRole || !city) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message:
            "Invalid input: userName, tempRole, custom:role, and city are required.",
        }),
      };
    }

    let newRole;
    if (currentRole.toLowerCase().includes(tempRole.toLowerCase())) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "Role is already updated or included",
        }),
      };
    } else {
      newRole = currentRole.toLowerCase() + "," + tempRole.toLowerCase();
    }
    console.log("newRole: ", newRole);
    const updatedAttributes = [
      {
        Name: "custom:role",
        Value: newRole,
      },
    ];

    console.log("USER_POOL_ID: ", USER_POOL_ID);
    console.log("username: ", userName);
    console.log("updatedAttributes: ", updatedAttributes);

    const resultCognito = await cognitoClient.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: USER_POOL_ID,
        Username: userName,
        UserAttributes: updatedAttributes,
      })
    );
    console.log("resultCognito: ", resultCognito);
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

    const dbResult = await dynamoDBClient.send(
      new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { UserID: userID },
        UpdateExpression: updateExpression.join(", "),
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
      })
    );
    console.log("dbResult: ", dbResult);
    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Role updated successfully" }),
    };
  } catch (error) {
    console.error("Error: ", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Internal Server Error",
        error: error.message,
      }),
    };
  }
};
