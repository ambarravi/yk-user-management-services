import DynamoDB from "@aws-sdk/client-dynamodb";
import S3 from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from "uuid";

const REGION = process.env.AWS_REGION;
const TABLE = process.env.ORGANIZER_TABLE;
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

const dynamoDBClient = new DynamoDB.DynamoDBClient({ region: REGION });
const s3Client = new S3.S3Client({ region: REGION });

export const handler = async (event) => {
  try {
    console.log("Input event:", JSON.stringify(event));

    // Parse JSON input
    const inputData = JSON.parse(event.body);
    const { username, logoFileName, logoFileType, ...profileData } = inputData;

    const getParams = {
      TableName: TABLE,
      Key: { OrganizerID: username },
    };

    const existingRecord = await dynamoDBClient.send(new GetCommand(getParams));

    const logoKey = `logo/${username}_${logoFileName}`;
    const logoPath = `https://${S3_BUCKET_NAME}.s3.${REGION}.amazonaws.com/${logoKey}`;

    const presignedUrl = await s3Client.send(
      new GetSignedUrlCommand({
        Bucket: S3_BUCKET_NAME,
        Key: logoKey,
        Expires: 300,
        ContentType: logoFileType,
      })
    );

    if (existingRecord.Item) {
      console.log(`Record found for username: ${username}. Updating...`);

      const updateParams = {
        TableName: TABLE,
        Key: { OrganizerID: username },
        UpdateExpression: `
          SET OrganizerName = :name,
              contactPerson = :contactPerson,
              contactEmail = :contactEmail,
              contactNumber = :contactNumber,
              alternateNumber = :alternateNumber,
              aboutOrganization = :aboutOrganization,
              termsAccepted = :termsAccepted,
              logoPath = :logoPath,
              metadata = :metadata
        `,
        ExpressionAttributeValues: {
          ":name": profileData.name,
          ":contactPerson": profileData.contactPerson,
          ":contactEmail": profileData.contactEmail,
          ":contactNumber": profileData.contactNumber,
          ":alternateNumber": profileData.alternateNumber,
          ":aboutOrganization": profileData.aboutOrganization,
          ":termsAccepted": profileData.termsAccepted,
          ":logoPath": logoPath,
          ":metadata": profileData.metadata,
        },
      };

      await dynamoDBClient.send(new UpdateCommand(updateParams));
      console.log("Record updated successfully.");
    } else {
      console.log(`No record found for username: ${username}. Inserting...`);

      const insertParams = {
        TableName: TABLE,
        Item: {
          OrganizerID: username,
          OrganizerName: profileData.name,
          contactPerson: profileData.contactPerson,
          contactEmail: profileData.contactEmail,
          contactNumber: profileData.contactNumber,
          alternateNumber: profileData.alternateNumber,
          aboutOrganization: profileData.aboutOrganization,
          termsAccepted: profileData.termsAccepted,
          logoPath: logoPath,
          metadata: profileData.metadata,
        },
      };

      await dynamoDBClient.send(new PutCommand(insertParams));
      console.log("Record inserted successfully.");
    }

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": event.headers.origin || "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
      body: JSON.stringify({
        message: "Operation completed successfully",
        presignedUrl,
      }),
    };
  } catch (error) {
    console.error("Error processing request:", error);
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": event.headers.origin || "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
      body: JSON.stringify({
        message: error.message || "Internal Server Error",
      }),
    };
  }
};
