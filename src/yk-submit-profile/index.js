import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid"; // Add uuid package for generating CollegeID

const dynamoDBClient = new DynamoDBClient({ region: "eu-west-1" });
const s3Client = new S3Client({ region: process.env.AWS_REGION });

export const handler = async (event) => {
  try {
    console.log("Input event:", JSON.stringify(event.body));

    const { username, logoFileName, logoFileType, ...profileData } = JSON.parse(
      event.body
    );

    const REGION = process.env.AWS_REGION;
    const ORGANIZER_TABLE = process.env.ORGANIZER_TABLE;
    const CITY_TABLE = process.env.CITY_TABLE; // Add this environment variable
    const COLLEGE_TABLE = process.env.COLLEGE_TABLE; // Add this environment variable
    const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

    console.log("ORGANIZER_TABLE:", ORGANIZER_TABLE);
    console.log("CITY_TABLE:", CITY_TABLE);
    console.log("COLLEGE_TABLE:", COLLEGE_TABLE);

    // Check if CityID exists in CityTable
    const cityGetParams = {
      TableName: CITY_TABLE,
      Key: {
        CityID: { S: profileData.cityID },
      },
    };
    const cityRecord = await dynamoDBClient.send(
      new GetItemCommand(cityGetParams)
    );

    if (!cityRecord.Item) {
      // CityID not found, insert new city
      const cityInsertParams = {
        TableName: CITY_TABLE,
        Item: {
          CityID: { S: profileData.cityID },
          CityName: { S: profileData.cityName },
          State: { S: profileData.state || "" },
          CreatedAt: { S: new Date().toISOString() },
        },
      };
      console.log("Insert city params:", JSON.stringify(cityInsertParams));
      await dynamoDBClient.send(new PutItemCommand(cityInsertParams));
      console.log("New city inserted successfully.");
    }

    // Check if collegeID is a custom name (not numeric or UUID-like)
    let collegeID = profileData.collegeID || "";
    const isCustomCollege =
      collegeID &&
      !collegeID.match(/^\d+$/) &&
      !collegeID.match(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );

    if (isCustomCollege && profileData.associatedCollegeUniversity === "Yes") {
      // Custom college name provided, check if it exists in CollegeTable
      const collegeGetParams = {
        TableName: COLLEGE_TABLE,
        Key: {
          CollegeID: { S: collegeID },
        },
      };
      const collegeRecord = await dynamoDBClient.send(
        new GetItemCommand(collegeGetParams)
      );

      if (!collegeRecord.Item) {
        // College not found, create new college entry
        collegeID = uuidv4(); // Generate new UUID for CollegeID
        const collegeInsertParams = {
          TableName: COLLEGE_TABLE,
          Item: {
            CollegeID: { S: collegeID },
            Name: { S: profileData.collegeID }, // Use the custom name as Name
            Shortform: { S: profileData.collegeID.slice(0, 3).toLowerCase() }, // Simple shortform (first 3 letters)
            City: { S: profileData.cityName.toLowerCase() },
            CityID: { S: profileData.cityID },
            University: { S: profileData.collegeID }, // Default to same as Name
          },
        };
        console.log(
          "Insert college params:",
          JSON.stringify(collegeInsertParams)
        );
        await dynamoDBClient.send(new PutItemCommand(collegeInsertParams));
        console.log("New college inserted successfully.");
      }
    }

    // Fetch existing organizer record
    const getParams = {
      TableName: ORGANIZER_TABLE,
      Key: {
        OrganizerID: { S: username },
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

    // Convert associatedCollegeUniversity from string to boolean
    const associatedCollegeUniversity =
      profileData.associatedCollegeUniversity === "Yes";

    if (existingRecord.Item) {
      if (existingRecord.Item.logoPath && !logoFileName) {
        logoPath = existingRecord.Item.logoPath.S;
        console.log("logoPath", logoPath);
        presignedUrl = "";
      }
      const updateParams = {
        TableName: ORGANIZER_TABLE,
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
              #state = :state,
              collegeID = :collegeID,
              address = :address,
              associatedCollegeUniversity = :associatedCollegeUniversity,
              logoPath = :logoPath,
              updatedAt = :updatedAt            
        `,
        ExpressionAttributeNames: {
          "#state": "state",
        },
        ExpressionAttributeValues: {
          ":name": { S: profileData.name },
          ":contactPerson": { S: profileData.contactPerson },
          ":contactEmail": { S: profileData.contactEmail },
          ":contactNumber": { S: profileData.contactNumber },
          ":alternateNumber": { S: profileData.alternateNumber },
          ":aboutOrganization": { S: profileData.aboutOrganization },
          ":termsAccepted": { BOOL: profileData.termsAccepted },
          ":cityID": { S: profileData.cityID },
          ":cityName": { S: profileData.cityName },
          ":state": { S: profileData.state || "" },
          ":collegeID": { S: collegeID },
          ":address": { S: profileData.address },
          ":associatedCollegeUniversity": { BOOL: associatedCollegeUniversity },
          ":logoPath": { S: logoPath },
          ":updatedAt": { S: new Date().toISOString() },
        },
      };
      console.log("Update params:", JSON.stringify(updateParams));
      await dynamoDBClient.send(new UpdateItemCommand(updateParams));
      console.log("Record updated successfully.");
    } else {
      const eventNumber = 2;
      const insertParams = {
        TableName: ORGANIZER_TABLE,
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
          cityName: { S: profileData.cityName },
          state: { S: profileData.state || "" },
          collegeID: { S: collegeID },
          address: { S: profileData.address },
          associatedCollegeUniversity: { BOOL: associatedCollegeUniversity },
          logoPath: { S: logoPath },
          createdAt: { S: new Date().toISOString() },
          eventsAllowed: { N: eventNumber.toString() },
        },
      };
      console.log("Insert params:", JSON.stringify(insertParams));
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
