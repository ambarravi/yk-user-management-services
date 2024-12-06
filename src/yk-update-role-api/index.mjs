import { CognitoIdentityProviderClient, AdminUpdateUserAttributesCommand } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
//import jwt from "jsonwebtoken";
const jwt = require("jsonwebtoken");

const REGION = process.env.AWS_REGION;
const USER_POOL_ID = process.env.USER_POOL_ID;
const ROLE_CONFIG = process.env.ROLE_CONFIG?.split(",") || ["user", "organizer"];
const USERS_TABLE = process.env.USERS_TABLE;

const dynamoDBClient = new DynamoDBClient({ region: REGION });
const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });

export const handler = async (event) => {
  // Handle OPTIONS (preflight request) here
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify({ message: 'CORS preflight request success' }),
    };
  }

  try {
    console.log('Input event');
    console.log(event);
    // Parse the event body to extract role and token
    

    // Validate role
    if (!ROLE_CONFIG.includes(event.tempRole)) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(),
        body: JSON.stringify({ message: `Invalid role name: ${roleName}` }),
      };
    }

    if (!authHeader) {
      return {
        statusCode: 401,
        body: JSON.stringify({ message: "Authorization header missing" }),
      };
    }

    console.log('Check  Token ' + token);
    const authHeader = event.headers.Authorization || event.headers.authorization;

      // Extract the Bearer token
      console.log('Extract  Token ' + token);
    const token = authHeader.split(' ')[1];
    if (!token) {
      return {
        statusCode: 401,
        body: JSON.stringify({ message: "Bearer token missing" }),
      };
    }

    console.log('Processing  Token ' + token);
    // Validate JWT token and extract user ID
    const decodedToken = jwt.decode(token, { complete: true });
    if (!decodedToken || !decodedToken.payload) {
      throw new Error("Invalid or missing token");
    }

    console.log('Decode Token ' + decodedToken);

    const userId = decodedToken.payload.sub;

    // Verify JWT token
    const JWKS_URL = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}/.well-known/jwks.json`;
    const publicKey = await fetchJWKS(JWKS_URL, decodedToken.header.kid);
    jwt.verify(token, publicKey, { algorithms: ["RS256"] });

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

// Helper function to fetch the public key from JWKS
async function fetchJWKS(jwksUrl, kid) {
  const response = await fetch(jwksUrl);
  if (!response.ok) throw new Error("Unable to fetch JWKS");
  const { keys } = await response.json();
  const key = keys.find((k) => k.kid === kid);
  if (!key) throw new Error("Key not found in JWKS");
  return `-----BEGIN PUBLIC KEY-----\n${key.x5c[0]}\n-----END PUBLIC KEY-----`;
}

// Helper function to get CORS headers
function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "http://localhost:3000", // Change to your CloudFront URL for production
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Amz-Date, X-Api-Key, X-Amz-Security-Token",
    "Access-Control-Allow-Methods": "OPTIONS, POST, GET, PUT, DELETE",
    "Access-Control-Allow-Credentials": "true", // Allow credentials if needed (cookies, etc.)
  };
}
