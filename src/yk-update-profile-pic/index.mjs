import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const REGION = process.env.AWS_REGION;
const USER_POOL_ID = process.env.USER_POOL_ID;
const BUCKET_NAME = process.env.S3_BUCKET_NAME;
const s3Client = new S3Client({ region: REGION });
const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });

export const handler = async (event) => {
  console.log("Event: ", JSON.stringify(event));

  try {
    const { userId } = JSON.parse(event.body);
    if (!userId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "userId is required" }),
      };
    }

    const fileName = `private/${userId}/profile-pic-${Date.now()}.jpg`;
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileName,
      ContentType: "image/jpeg",
    });

    const uploadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 3600,
    }); // 1 hour expiry
    console.log("Generated presigned URL for upload:", uploadUrl);

    // Store S3 key in Cognito
    await cognitoClient.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: USER_POOL_ID,
        Username: userId, // Assumes userId matches Cognito username; adjust if needed
        UserAttributes: [{ Name: "picture", Value: fileName }],
      })
    );
    console.log("Cognito updated with picture key:", fileName);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Presigned URL generated successfully",
        uploadUrl,
        pictureKey: fileName,
      }),
    };
  } catch (error) {
    console.error("Error generating presigned URL:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Internal Server Error",
        error: error.message,
      }),
    };
  }
};
