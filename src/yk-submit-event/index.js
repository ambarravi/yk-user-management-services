import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid";

const dynamoDBClient = new DynamoDBClient({ region: "eu-west-1" });
const s3Client = new S3Client({ region: process.env.AWS_REGION });

export const handler = async (event) => {
  try {
    if (!event.body) {
      throw new Error("Request body is missing.");
    }

    console.log("Input event body:", event.body);
    const parsedBody = JSON.parse(event.body);

    const {
      EventID,
      readableEventID,
      OrgID,
      eventImages = [],
      ...eventDetails
    } = parsedBody;

    if (!OrgID) {
      throw new Error("Organization ID (OrgID) is required.");
    }

    console.log(EventID);
    const uniqueEventID = EventID || uuidv4();
    console.log(uniqueEventID);
    const REGION = process.env.AWS_REGION;
    const TABLE = process.env.EVENT_TABLE;
    const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

    const sanitizeString = (value) =>
      value && value.trim() !== "" ? { S: value } : undefined;

    if (!REGION || !TABLE || !S3_BUCKET_NAME) {
      throw new Error(
        "Missing required environment variables: AWS_REGION, EVENTS_TABLE, or S3_BUCKET_NAME."
      );
    }

    // Validate and process event images
    if (!readableEventID) {
      readableEventID = await generateReadableEventID();
      console.log(" ReadableEventID not found :", readableEventID);
    }
    console.log("Final ReadableEventID:", readableEventID);
    const presignedUrlsResult = [];
    const imageUrls = [];
    const maxImages = 3;
    for (let i = 0; i < Math.min(eventImages.length, maxImages); i++) {
      const image = eventImages[i];
      if (!image || !image.type) {
        console.warn(`Skipping invalid image at index ${i}:`, image);
        continue;
      }

      const imageKey = `event-images/${readableEventID}/${image.name}`;

      try {
        const presignedUrl = await getSignedUrl(
          s3Client,
          new PutObjectCommand({
            Bucket: S3_BUCKET_NAME,
            Key: imageKey,
            ContentType: image.type,
          }),
          { expiresIn: 300 }
        );
        imageUrls.push(
          `https://${S3_BUCKET_NAME}.s3.${REGION}.amazonaws.com/${imageKey}`
        );
        presignedUrlsResult.push(presignedUrl);
        console.log(
          `Generated presigned URL for image ${i + 1}:`,
          presignedUrl
        );
      } catch (err) {
        console.error(
          `Failed to generate presigned URL for image ${i + 1}:`,
          err
        );
      }
    }

    console.log("Final image URLs:", imageUrls);

    // Prepare event data for DynamoDB
    const eventPayload = {
      EventID: { S: uniqueEventID },
      OrgID: { S: OrgID },
      EventTitle: { S: eventDetails.eventTitle || "" },
      EventDate: { S: eventDetails.dateTime || "" },
      EventLocation: { S: eventDetails.eventLocation || "" },
      EventDetails: { S: eventDetails.eventDetails || "" },
      EventImages: imageUrls.length
        ? { L: imageUrls.map((url) => ({ S: url })) }
        : { L: [] }, // Empty list if no images
      CityID: { S: eventDetails.cityID || "" },
      CategoryID: { S: eventDetails.categoryID || "" },
      EventType: { S: eventDetails.eventType || "" },
      Tags: { S: eventDetails.tags || "" },
      EventHighLight: { S: eventDetails.highlight || "" },
      Price: { N: eventDetails.ticketPrice || "0" },
      Seats: { N: eventDetails.noOfSeats || "0" },
      ReservedSeats: { N: eventDetails.reserveSeats || "0" },
      AudienceBenefits:
        eventDetails.audienceBenefits &&
        eventDetails.audienceBenefits.length > 0
          ? {
              L: eventDetails.audienceBenefits
                .filter((benefit) => benefit.trim() !== "") // Remove empty strings
                .map((benefit) => ({
                  S: benefit,
                })),
            }
          : { L: [] }, // Empty array if no benefits are provided
      AdditionalInfo: { S: eventDetails.additionalInfo || "" },
      EventMode: { S: eventDetails.mode || "" },
    };

    // Check if the event already exists
    const getParams = {
      TableName: TABLE,
      Key: { EventID: { S: uniqueEventID } },
    };

    const existingRecord = await dynamoDBClient.send(
      new GetItemCommand(getParams)
    );
    //console.log("Existing Record:", existingRecord);

    if (existingRecord.Item) {
      console.log("Event already exists. Updating...");
      const updateParams = {
        TableName: TABLE,
        Key: { EventID: { S: uniqueEventID } },
        UpdateExpression: `SET EventTitle = :eventTitle, EventDate = :eventDate, EventLocation = :eventLocation, 
        EventDetails = :eventDetails, EventImages = :eventImages, CityID = :cityID, CategoryID = :categoryID, 
        EventType = :eventType, Tags = :tags, EventHighLight = :eventHighLight, Price = :price, Seats = :seats,
         ReservedSeats = :reservedSeats, AudienceBenefits = :audienceBenefits, AdditionalInfo = :additionalInfo, 
         EventMode = :mode, OrgID = :orgID`,
        ExpressionAttributeValues: {
          ":eventTitle": { S: eventDetails.eventTitle || "" },
          ":eventDate": { S: eventDetails.dateTime || "" },
          ":eventLocation": { S: eventDetails.eventLocation || "" },
          ":eventDetails": { S: eventDetails.eventDetails || "" },
          // ":eventImages": { L: imageUrls.map((url) => ({ S: url })) },
          ":eventImages": imageUrls.length
            ? { L: imageUrls.map((url) => ({ S: url })) }
            : { L: [] }, // Use `:eventImages` as key instead of `eventImages`
          ":cityID": { S: eventDetails.cityID || "" },
          ":categoryID": { S: eventDetails.categoryID || "" },
          ":eventType": { S: eventDetails.eventType || "" },
          ":tags": { S: eventDetails.tags || "" },
          ":eventHighLight": { S: eventDetails.highlight || "" },
          ":price": {
            N: eventDetails.ticketPrice
              ? eventDetails.ticketPrice.toString()
              : "0",
          },
          ":seats": {
            N: eventDetails.noOfSeats ? eventDetails.noOfSeats.toString() : "0",
          },
          ":reservedSeats": {
            N: eventDetails.reserveSeats
              ? eventDetails.reserveSeats.toString()
              : "0",
          },
          ":audienceBenefits":
            eventDetails.audienceBenefits &&
            eventDetails.audienceBenefits.length > 0
              ? {
                  L: eventDetails.audienceBenefits
                    .filter((benefit) => benefit.trim() !== "") // Remove empty strings
                    .map((benefit) => ({
                      S: benefit,
                    })),
                }
              : { L: [] },
          ":additionalInfo": { S: eventDetails.additionalInfo || "" },
          ":mode": { S: eventDetails.mode || "" },
          ":orgID": { S: OrgID },
        },
      };

      console.log("Update Params:", JSON.stringify(updateParams, null, 2));
      await dynamoDBClient.send(new UpdateItemCommand(updateParams));
      console.log("Event updated successfully.");
    } else {
      console.log("Inserting new event...");

      console.log("Generated ReadableEventID:", readableEventID);
      eventPayload.ReadableEventID = {
        S: readableEventID,
      };

      const insertParams = {
        TableName: TABLE,
        Item: eventPayload,
      };

      console.log("Insert Params:", JSON.stringify(insertParams, null, 2));
      await dynamoDBClient.send(new PutItemCommand(insertParams));
      console.log("Event inserted successfully.");
    }

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
      body: JSON.stringify({
        message: "Event submission completed successfully.",
        presignedUrls: presignedUrlsResult,
      }),
    };
  } catch (error) {
    console.error("Error processing event:", error);
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

const generateReadableEventID = async () => {
  const eventSequenceValue = "EventSequenceID"; // This value will always be the same
  const tableName = "EventIDGenerator"; // Your table name

  try {
    // Step 1: Retrieve the current sequence number
    const getParams = {
      TableName: tableName,
      Key: { EventSequence: { S: eventSequenceValue } },
    };
    console.log("Get Params:", getParams);

    const getResult = await dynamoDBClient.send(new GetItemCommand(getParams));
    console.log("Get Result:", getResult);

    if (!getResult.Item || !getResult.Item.Sequence) {
      throw new Error(
        `Sequence attribute is missing in DynamoDB for key: ${eventSequenceValue}`
      );
    }

    const currentSequence = parseInt(getResult.Item.Sequence.N, 10);
    console.log("Current Sequence:", currentSequence);

    // Step 2: Increment the sequence number
    const newSequence = currentSequence + 1;

    const updateParams = {
      TableName: tableName,
      Key: { EventSequence: { S: eventSequenceValue } },
      UpdateExpression: "SET #seq = :newSeq",
      ExpressionAttributeNames: { "#seq": "Sequence" },
      ExpressionAttributeValues: { ":newSeq": { N: newSequence.toString() } },
      ReturnValues: "UPDATED_NEW",
    };
    console.log("Update Params:", updateParams);

    const updateResult = await dynamoDBClient.send(
      new UpdateItemCommand(updateParams)
    );
    console.log("Update Result:", updateResult);

    // Step 3: Return the readable event ID
    return `EVT-${newSequence.toString().padStart(6, "0")}`;
  } catch (error) {
    console.error("Error generating ReadableEventID:", error);
    throw new Error("Error generating ReadableEventID");
  }
};
