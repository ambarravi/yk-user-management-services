import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const REGION = process.env.AWS_REGION;
const BUCKET_NAME = process.env.S3_BUCKET_NAME;

const s3Client = new S3Client({ region: REGION });

export const handler = async (event) => {
  console.log("Event received:", JSON.stringify(event));

  try {
    const { pictureKey } = JSON.parse(event.body);
    if (!pictureKey) throw new Error("pictureKey is required");
    console.log("Generating pre-signed URL for pictureKey:", pictureKey);

    // Generate GET pre-signed URL
    const getCommand = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: pictureKey,
    });
    const url = await getSignedUrl(s3Client, getCommand, {
      expiresIn: 3600, // 1 hour expiration
    });
    console.log("Generated pre-signed URL:", url);

    console.log("Lambda execution completed successfully");
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Pre-signed URL generated successfully",
        url,
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
