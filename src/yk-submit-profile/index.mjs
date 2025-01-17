import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import formidable from "formidable";
import { PutCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION;
const TABLE = process.env.ORGANIZER_TABLE;
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

const dynamoDBClient = new DynamoDBClient({ region: REGION });
// Helper function to generate CORS headers
const getCorsHeaders = (origin) => ({
  "Access-Control-Allow-Origin": origin || "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
});
export const handler = async (event) => {
  try {
    console.log("Input event:", JSON.stringify(event));

    const form = new formidable.IncomingForm();
    // Parse the multipart/form-data
    const data = await new Promise((resolve, reject) => {
      form.parse(event, (err, fields, files) => {
        if (err) reject(err);
        resolve({ fields, files });
      });
    });

    const { fields, files } = data;
    const logoFile = files.logo;

    // Generate a UUID for the OrganizerID
    const OrganizerID = uuidv4();
    console.log("Generated OrganizerID:", OrganizerID);

    // Upload the logo file to S3
    const s3Client = new S3Client({ region: REGION });
    const uploadParams = {
      Bucket: S3_BUCKET_NAME,
      Key: `logo/${OrganizerID}_${logoFile.originalFilename}`,
      Body: fs.createReadStream(logoFile.filepath),
      ContentType: logoFile.mimetype,
    };

    let uploadResult;
    try {
      uploadResult = await s3Client.send(new PutObjectCommand(uploadParams));
      console.log("Successfully uploaded logo to S3:", uploadParams.Key);
    } catch (s3Error) {
      console.error("Failed to upload logo to S3:", s3Error);
      throw new Error("Error uploading logo to S3");
    }

    // Construct the logo path (update as per your bucket's URL pattern)
    const logoPath = `https://${S3_BUCKET_NAME}.s3.${REGION}.amazonaws.com/${uploadParams.Key}`;

    // Insert data into DynamoDB
    const dynamoParams = {
      TableName: TABLE,
      Item: {
        OrganizerID: OrganizerID,
        OrganizerName: fields.name,
        contactPerson: fields.contactPerson,
        contactEmail: fields.contactEmail,
        contactNumber: fields.contactNumber,
        alternateNumber: fields.alternateNumber,
        aboutOrganization: fields.aboutOrganization,
        termsAccepted: fields.termsAccepted,
        logoPath: logoPath,
        metadata: JSON.parse(fields.metadata),
      },
    };

    try {
      console.log("DynamoDB Insert Params:", JSON.stringify(dynamoParams));
      const putCommand = new PutCommand(dynamoParams);
      await dynamoDBClient.send(putCommand);
      console.log(
        "Successfully inserted data into DynamoDB for OrganizerName:",
        fields.name
      );
    } catch (dynamoError) {
      console.error("Failed to insert data into DynamoDB:", dynamoError);
      throw new Error("Error inserting data into DynamoDB");
    }

    return {
      statusCode: 200,
      headers: getCorsHeaders(event.headers.origin),
      body: JSON.stringify({ message: "Data inserted successfully" }),
    };
  } catch (error) {
    console.error("Error processing request:", error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event.headers.origin),
      body: JSON.stringify({
        message: error.message || "Internal Server Error",
      }),
    };
  }
};
