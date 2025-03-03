import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const REGION = process.env.AWS_REGION;
const USER_POOL_ID = "eu-west-1_hgUDdjyRr";
const BUCKET_NAME = "myapp-profileStorage-<id>-<env>";
const s3Client = new S3Client({ region: REGION });
const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });

export const handler = async (event) => {
  try {
    const { userId } = JSON.parse(event.body);
    if (!userId) throw new Error("userId is required");

    const fileName = `private/${userId}/profile-pic-${Date.now()}.jpg`;

    // Generate PUT presigned URL for upload
    const putCommand = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileName,
      ContentType: "image/jpeg",
    });
    const uploadUrl = await getSignedUrl(s3Client, putCommand, {
      expiresIn: 3600,
    });

    // Generate GET presigned URL for display
    const getCommand = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileName,
    });
    const displayUrl = await getSignedUrl(s3Client, getCommand, {
      expiresIn: 3600,
    });

    // Update Cognito
    await cognitoClient.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: USER_POOL_ID,
        Username: userId,
        UserAttributes: [{ Name: "picture", Value: fileName }],
      })
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Presigned URL generated successfully",
        uploadUrl,
        pictureKey: fileName,
        displayUrl, // Add this to the response
      }),
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
