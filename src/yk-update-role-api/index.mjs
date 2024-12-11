import { CognitoIdentityProviderClient, AdminUpdateUserAttributesCommand } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { decodeJwt, importJWK, jwtVerify, createRemoteJWKSet } from "jose";

const REGION = process.env.AWS_REGION;
const USER_POOL_ID = process.env.USER_POOL_ID;
const ROLE_CONFIG = process.env.ROLE_CONFIG?.split(",") || ["user", "organizer"];
const USERS_TABLE = process.env.USERS_TABLE;

const dynamoDBClient = new DynamoDBClient({ region: REGION });
const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });
const JWKS_URL = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}/.well-known/jwks.json`;

export const handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin;

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: getCorsHeaders(origin),
      body: JSON.stringify({ message: "CORS preflight request success" }),
    };
  }

  try {
    console.log("Input event:", JSON.stringify(event));

    const authHeader = event.headers.Authorization || event.headers.authorization;
    if (!authHeader) {
      console.error("Authorization header missing");
      return {
        statusCode: 401,
        body: JSON.stringify({ message: "Authorization header missing" }),
      };
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      console.error("Bearer token missing");
      return {
        statusCode: 401,
        body: JSON.stringify({ message: "Bearer token missing" }),
      };
    }

    console.log("Processing Token:", token);

    // Create a remote JWKS set
    const JWKS = createRemoteJWKSet(new URL(JWKS_URL));

    // Verify the token and extract payload
    const { payload } = await jwtVerify(token, JWKS, {
      algorithms: ["RS256"],
    });

    console.log("Decoded Token Payload:", payload);
    const role = user['custom:role'];
    console.log(role); // Output: 'organizer'

    if(role)
    {
      return {
        statusCode: 200,
        headers: getCorsHeaders(origin),
        body: JSON.stringify({ message: "Role is already assigned" }),
      };

    }

    const UserID = payload.sub;

    // Extract role and validate
    const parsedBody = JSON.parse(event.body);
    console.log("Event Body:", JSON.stringify(parsedBody));

    const { username, tempRole } = parsedBody;

    console.log("Decoded Token tempRole:", tempRole);
    if (!ROLE_CONFIG.includes(tempRole)) {
      console.error(`Invalid role name: ${tempRole}`);
      return {
        statusCode: 400,
        headers: getCorsHeaders(origin),
        body: JSON.stringify({ message: `Invalid role name: ${tempRole}` }),
      };
    }

    // Update role in Cognito
    const cognitoParams = {
      UserPoolId: USER_POOL_ID,
      Username: UserID,
      UserAttributes: [{ Name: "custom:role", Value: tempRole }],
    };

    try {
      const updateUserCommand = new AdminUpdateUserAttributesCommand(cognitoParams);
      await cognitoClient.send(updateUserCommand);
      console.log("Successfully updated role in Cognito for UserID:", UserID);
    } catch (cognitoError) {
      console.error("Failed to update role in Cognito:", cognitoError);
      throw new Error("Error updating role in Cognito");
    }

    // Update role in DynamoDB
    const dynamoParams = {
      TableName: USERS_TABLE,
      Key: { UserID },
      UpdateExpression: "SET #role = :tempRole",
      ExpressionAttributeNames: { "#role": "role" },
      ExpressionAttributeValues: { ":tempRole": tempRole },
    };

    try {
      console.log("DynamoDB Update Params:", JSON.stringify(dynamoParams));
      const updateCommand = new UpdateCommand(dynamoParams);
      await dynamoDBClient.send(updateCommand);
      console.log("Successfully updated role in DynamoDB for UserID:", UserID);
    } catch (dynamoError) {
      console.error("Failed to update role in DynamoDB:", dynamoError);
      throw new Error("Error updating role in DynamoDB");
    }

    return {
      statusCode: 200,
      headers: getCorsHeaders(origin),
      body: JSON.stringify({ message: "Role updated successfully" }),
    };
  } catch (error) {
    console.error("Error processing request:", error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(origin),
      body: JSON.stringify({ message: error.message || "Internal Server Error" }),
    };
  }
};

// Helper function to get CORS headers
function getCorsHeaders(origin) {
  console.log("in getCorsHeaders function");

  const allowedOrigins = [
    "http://localhost:3000",
    "https://dom5rgdes5ko4.cloudfront.net",
  ];

  const isOriginAllowed = allowedOrigins.includes(origin);

  console.log("Allowed Origin:", isOriginAllowed);
  return {
    "Access-Control-Allow-Origin": isOriginAllowed ? origin : "http://localhost:3000",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Amz-Date, X-Api-Key, X-Amz-Security-Token",
    "Access-Control-Allow-Methods": "OPTIONS, POST, GET, PUT, DELETE",
    "Access-Control-Allow-Credentials": "true",
  };
}
