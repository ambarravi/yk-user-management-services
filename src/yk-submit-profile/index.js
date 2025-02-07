import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const dynamoDBClient = new DynamoDBClient({ region: "eu-west-1" });
const s3Client = new S3Client({ region: process.env.AWS_REGION });

export const handler = async (event) => {
  try {
    console.log("Input event:", JSON.stringify(event.body));

    const { username, logoFileName, logoFileType, ...profileData } = JSON.parse(
      event.body
    );

    const REGION = process.env.AWS_REGION;
    const TABLE = process.env.ORGANIZER_TABLE;
    const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

    console.log("TABLE:", TABLE);

    const getParams = {
      TableName: TABLE,
      Key: {
        OrganizerID: {
          S: username,
        },
      },
    };

    console.log("Get params:", JSON.stringify(getParams));

    const existingRecord = await dynamoDBClient.send(
      new GetItemCommand(getParams)
    );

    console.log("Existing record:", existingRecord);

    const logoKey = `logo/${username}_${logoFileName}`;
    let logoPath = `https://${S3_BUCKET_NAME}.s3.${REGION}.amazonaws.com/${logoKey}`;

    console.log("Logo key:", logoKey);

    // Generate the presigned URL
    let presignedUrl = await getSignedUrl(
      s3Client,
      new PutObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: logoKey,
        ContentType: logoFileType,
      }),
      { expiresIn: 300 }
    );

    console.log("Presigned URL:", presignedUrl);

    if (existingRecord.Item) {
      if (existingRecord.Item.logoPath && !logoFileName) {
        logoPath = existingRecord.Item.logoPath.S;
        console.log("logoPath", logoPath);
        presignedUrl = "";
      }
      const updateParams = {
        TableName: TABLE,
        Key: { OrganizerID: { S: username } },
        UpdateExpression: `
          SET OrganizerName = :name,
              contactPerson = :contactPerson,
              contactEmail = :contactEmail,
              contactNumber = :contactNumber,
              alternateNumber = :alternateNumber,
              aboutOrganization = :aboutOrganization,
              termsAccepted = :termsAccepted,
              cityID = :cityID,
              cityName = :cityName,
              collegeID = :collegeID,
              address = :address,
              associatedCollegeUniversity =:associatedCollegeUniversity,
              logoPath = :logoPath,
              updatedAt = :updatedAt            
        `,
        ExpressionAttributeValues: {
          ":name": { S: profileData.name },
          ":contactPerson": { S: profileData.contactPerson },
          ":contactEmail": { S: profileData.contactEmail },
          ":contactNumber": { S: profileData.contactNumber },
          ":alternateNumber": { S: profileData.alternateNumber },
          ":aboutOrganization": { S: profileData.aboutOrganization },
          ":termsAccepted": { BOOL: profileData.termsAccepted },
          ":cityID": { S: profileData.cityID },
          ":cityName": { S: profileData.venueCityName },
          ":collegeID": profileData.collegeID
            ? { S: profileData.collegeID }
            : { S: "" },
          ":address": { S: profileData.address },
          ":associatedCollegeUniversity": {
            BOOL: profileData.associatedCollegeUniversity,
          },

          ":logoPath": { S: logoPath },
          ":updatedAt": { S: new Date().toISOString() },
        },
      };
      console.log(updateParams);
      await dynamoDBClient.send(new UpdateItemCommand(updateParams));
      console.log("Record updated successfully.");
    } else {
      const insertParams = {
        TableName: TABLE,
        Item: {
          OrganizerID: { S: username },
          OrganizerName: { S: profileData.name },
          contactPerson: { S: profileData.contactPerson },
          contactEmail: { S: profileData.contactEmail },
          contactNumber: { S: profileData.contactNumber },
          alternateNumber: { S: profileData.alternateNumber },
          aboutOrganization: { S: profileData.aboutOrganization },
          termsAccepted: { BOOL: profileData.termsAccepted },
          cityID: { S: profileData.cityID },
          cityName: { S: profileData.venueCityName },
          collegeID: profileData.collegeID
            ? { S: profileData.collegeID }
            : { S: "" },
          address: { S: profileData.address },
          associatedCollegeUniversity: {
            BOOL: profileData.associatedCollegeUniversity,
          },
          logoPath: { S: logoPath },
          createdAt: { S: new Date().toISOString() },
        },
      };
      console.log("insertParams", insertParams);
      await dynamoDBClient.send(new PutItemCommand(insertParams));
      console.log("Record inserted successfully.");
    }

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
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
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
      body: JSON.stringify({
        message: error.message || "Internal Server Error",
      }),
    };
  }
};
