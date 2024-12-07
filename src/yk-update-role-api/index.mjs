import { CognitoIdentityProviderClient, AdminUpdateUserAttributesCommand } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
//import { createRemoteJWKSet, jwtVerify } from "jose";
//import { jwtVerify } from 'jose/dist/browser/jwt/verify'
import { decodeJwt, importJWK, jwtVerify } from 'jose';

const REGION = process.env.AWS_REGION;
const USER_POOL_ID = process.env.USER_POOL_ID;
const ROLE_CONFIG = process.env.ROLE_CONFIG?.split(",") || ["user", "organizer"];
const USERS_TABLE = process.env.USERS_TABLE;

const dynamoDBClient = new DynamoDBClient({ region: REGION });
const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });
const JWKS_URL = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}/.well-known/jwks.json`;

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify({ message: "CORS preflight request success" }),
    };
  }

  try {
    console.log("Input event:", event);

    const authHeader = event.headers.Authorization || event.headers.authorization;
    if (!authHeader) {
      return {
        statusCode: 401,
        body: JSON.stringify({ message: "Authorization header missing" }),
      };
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      return {
        statusCode: 401,
        body: JSON.stringify({ message: "Bearer token missing" }),
      };
    }

    console.log("Processing Token:", token);

    // Create a remote JWKS set
    const JWKS = createRemoteJWKSet(new URL(JWKS_URL));

    // Verify the token and extract payload
    const { payload } =  await jwtVerify(token, JWKS, {
      algorithms: ["RS256"],
    });

    console.log("Decoded Token Payload:", payload);

    const userId = payload.sub;

    // Extract role and validate
    const roleName = event.tempRole;
    if (!ROLE_CONFIG.includes(roleName)) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(),
        body: JSON.stringify({ message: `Invalid role name: ${roleName}` }),
      };
    }

    // Update role in Cognito
    const cognitoParams = {
      UserPoolId: USER_POOL_ID,
      Username: userId,
      UserAttributes: [{ Name: "custom:role", Value: roleName }],
    };
    const updateUserCommand = new AdminUpdateUserAttributesCommand(cognitoParams);
    await cognitoClient.send(updateUserCommand);

    // Update role in DynamoDB
    const dynamoParams = {
      TableName: USERS_TABLE,
      Key: { userId },
      UpdateExpression: "SET #role = :roleName",
      ExpressionAttributeNames: { "#role": "role" },
      ExpressionAttributeValues: { ":roleName": roleName },
    };
    const updateCommand = new UpdateCommand(dynamoParams);
    await dynamoDBClient.send(updateCommand);

    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify({ message: "Role updated successfully" }),
    };
  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ message: error.message || "Internal Server Error" }),
    };
  }
};

// Helper function to get CORS headers
function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "http://localhost:3000", // Update with your production URL
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Amz-Date, X-Api-Key, X-Amz-Security-Token",
    "Access-Control-Allow-Methods": "OPTIONS, POST, GET, PUT, DELETE",
    "Access-Control-Allow-Credentials": "true",
  };
}
