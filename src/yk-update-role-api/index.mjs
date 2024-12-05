import { CognitoIdentityProviderClient, AdminUpdateUserAttributesCommand } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import jwt from "jsonwebtoken";

const REGION = process.env.AWS_REGION; // AWS region
const USER_POOL_ID = process.env.USER_POOL_ID; // Cognito User Pool ID
const ROLE_CONFIG = process.env.ROLE_CONFIG?.split(",") || ["user", "organizer"]; // Valid roles from environment variable
const USERS_TABLE = process.env.USERS_TABLE; // DynamoDB Table

const dynamoDBClient = new DynamoDBClient({ region: REGION });
const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });

export const handler = async (event) => {
  try {
    // Parse the event body to extract role and token
    const { roleName, token } = JSON.parse(event.body);

    // Validate role
    if (!ROLE_CONFIG.includes(roleName)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: `Invalid role name: ${roleName}` }),
      };
    }

    // Validate JWT token and extract user ID
    const decodedToken = jwt.decode(token, { complete: true });
    if (!decodedToken || !decodedToken.payload) {
      throw new Error("Invalid or missing token");
    }
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
      body: JSON.stringify({ message: "Role updated successfully" }),
    };
  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 500,
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
