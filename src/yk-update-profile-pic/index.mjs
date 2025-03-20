import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const REGION = process.env.AWS_REGION;
const USER_POOL_ID = process.env.USER_POOL_ID;
const BUCKET_NAME = process.env.S3_BUCKET_NAME;
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;

const s3Client = new S3Client({ region: REGION });
const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });
const dynamoClient = new DynamoDBClient({ region: REGION });

export const handler = async (event) => {
  console.log("Event received:", JSON.stringify(event));

  try {
    const { userId } = JSON.parse(event.body);
    if (!userId) throw new Error("userId is required");
    console.log("Processing for userId (sub):", userId);

    // Step 1: Get the Cognito Username using sub
    console.log("Fetching Cognito user by sub:", userId);
    const getUserResponse = await cognitoClient
      .send(
        new AdminGetUserCommand({
          UserPoolId: USER_POOL_ID,
          Username: userId, // Try sub first
        })
      )
      .catch(async (error) => {
        if (error.name === "UserNotFoundException") {
          // If sub fails, assume userId is not the Username and search by sub is not direct
          // This requires a workaround if Cognito Username differs from sub
          throw new Error(
            "User not found with provided sub. Ensure userId matches Cognito Username or adjust logic."
          );
        }
        throw error;
      });
    const cognitoUsername = getUserResponse.Username;
    console.log("Cognito Username retrieved:", cognitoUsername);

    const fileName = `private/${userId}/profile-pic-${Date.now()}.jpg`;
    console.log("Generated fileName:", fileName);

    // Generate PUT presigned URL for upload
    const putCommand = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileName,
      ContentType: "image/jpeg",
    });
    const uploadUrl = await getSignedUrl(s3Client, putCommand, {
      expiresIn: 3600,
    });
    console.log("Generated uploadUrl:", uploadUrl);

    // Generate GET presigned URL for display
    const getCommand = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileName,
    });
    const displayUrl = await getSignedUrl(s3Client, getCommand, {
      expiresIn: 3600,
    });
    console.log("Generated displayUrl:", displayUrl);

    // Update Cognito using the retrieved Username
    console.log(
      "Updating Cognito with picture:",
      fileName,
      "for Username:",
      cognitoUsername
    );
    const cognitoResponse = await cognitoClient.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: USER_POOL_ID,
        Username: cognitoUsername, // Use the fetched Username
        UserAttributes: [{ Name: "picture", Value: fileName }], // Or "custom:picture" if applicable
      })
    );
    console.log("Cognito update response:", JSON.stringify(cognitoResponse));

    // Update DynamoDB Users Table
    console.log("Updating DynamoDB with picture:", fileName);
    const dynamoResponse = await dynamoClient.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: {
          UserID: { S: userId }, // Assuming userId (sub) is the partition key
        },
        UpdateExpression: "SET picture = :picture",
        ExpressionAttributeValues: {
          ":picture": { S: fileName },
        },
      })
    );
    console.log("DynamoDB update response:", JSON.stringify(dynamoResponse));

    console.log("Lambda execution completed successfully");
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Presigned URL generated successfully",
        uploadUrl,
        pictureKey: fileName,
        displayUrl,
      }),
    };
  } catch (error) {
    console.error("Error in Lambda execution:", error.message, error.stack);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Internal Server Error",
        error: error.message,
      }),
    };
  }
};
