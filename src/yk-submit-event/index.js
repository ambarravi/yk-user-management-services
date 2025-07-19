import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid";
import sw from "stopword";

const dynamoDBClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const s3Client = new S3Client({ region: process.env.AWS_REGION });
const sqsClient = new SQSClient({ region: process.env.AWS_REGION });

export const handler = async (event) => {
  try {
    if (!event.body) {
      throw new Error("Request body is missing.");
    }

    console.log("Input event body:", event.body);
    const parsedBody = JSON.parse(event.body);

    const {
      EventID,
      OrgID,
      eventImages = [],
      newImages = [],
      oldImages = [],
      ...eventDetails
    } = parsedBody;
    let readableEventID = parsedBody.readableEventID;

    eventDetails.tags = generateTagsFromTitle(
      eventDetails.eventTitle,
      eventDetails.tags
    );

    if (!OrgID) {
      throw new Error("Organization ID (OrgID) is required.");
    }

    console.log(EventID);
    const uniqueEventID = EventID || uuidv4();
    console.log(uniqueEventID);
    const TABLE = process.env.EVENT_TABLE;
    const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

    const sanitizeString = (value) =>
      value && value.trim() !== "" ? { S: value } : undefined;

    if (!TABLE || !S3_BUCKET_NAME) {
      throw new Error(
        "Missing required environment variables: AWS_REGION, EVENTS_TABLE, or S3_BUCKET_NAME."
      );
    }

    // Validate and process event images
    if (!EventID) {
      readableEventID = await generateReadableEventID();
      console.log(" ReadableEventID not found :", readableEventID);
    }
    console.log("Final ReadableEventID:", readableEventID);
    const presignedUrlsResult = [];
    const imageUrls = [];
    const maxImages = 3;
    for (let i = 0; i < Math.min(newImages.length, maxImages); i++) {
      const image = newImages[i];
      // if (!image || !image.type) {
      //   console.warn(`Skipping invalid image at index ${i}:`, image);
      //   continue;
      // }

      if (image.status === "new") {
        console.log("New Image");
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
            `https://${S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${imageKey}`
          );
          presignedUrlsResult.push(presignedUrl);
          console.log(
            `Generated presigned URL for image ${i + 1}:`,
            presignedUrl
          );
        } catch (err) {
          console.error("Error details:", {
            message: err.message,
            stack: err.stack,
          });
          console.error(
            `Failed to generate presigned URL for image ${i + 1}:`,
            err
          );
        }
      }
    }

    console.log("Check for Old images", oldImages);

    oldImages.forEach((x) => {
      console.log("old image url", x.url);
      imageUrls.push(x.url);
    });
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
      CategoryName: { S: eventDetails.categoryName || "" },
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
      OrganizerName: { S: eventDetails.OrganizerName || "" },
      EventMode: { S: eventDetails.eventMode || "" },
      EventStatus: { S: "AwaitingApproval" },
    };

    const collegeID = await getCollegeID(OrgID);
    if (collegeID) {
      eventPayload.CollegeID = { S: collegeID };
    }

    // Check if the event already exists
    const getParams = {
      TableName: TABLE,
      Key: { EventID: { S: uniqueEventID } },
    };

    const existingRecord = await dynamoDBClient.send(
      new GetItemCommand(getParams)
    );
    console.log("Existing Record:", existingRecord);

    if (existingRecord.Item) {
      // After existingRecord.Item is fetched and before the event is updated
      const wasPublished = existingRecord.Item.EventStatus?.S === "Published";
      let updateType = null;

      // Check for reschedule (date/time changed)

      const normalizeDate = (str) => new Date(str).toISOString();

      const normalizeEventDates = (arr) =>
        (arr || []).map((d) => ({
          eventDate: normalizeDate(d.eventDate),
          startTime: normalizeDate(d.startTime),
          endTime: normalizeDate(d.endTime),
        }));

      const existingNormalized = normalizeEventDates(existingEventDates);
      const newNormalized = normalizeEventDates(body.eventDates);

      console.log("Existing Dates:", JSON.stringify(existingNormalized));
      console.log("New Dates:", JSON.stringify(newNormalized));

      if (
        JSON.stringify(existingNormalized) !== JSON.stringify(newNormalized)
      ) {
        updateType = "RESCHEDULED";
      }

      // if (existingRecord.Item.EventDate?.S !== eventDetails.dateTime) {
      //   updateType = "RESCHEDULED";
      // }

      // Check for venue change
      if (existingRecord.Item.EventLocation?.S !== eventDetails.eventLocation) {
        updateType = updateType ? "EVENT_UPDATED" : "VENUE_CHANGED";
      }

      // Check for other field updates (excluding tags, images etc for simplicity)
      const otherFieldsChanged = [
        "eventTitle",
        "eventDetails",
        "highlight",
        "ticketPrice",
        "noOfSeats",
        "eventType",
      ].some((field) => {
        const existingVal = existingRecord.Item[camelToPascal(field)]?.S || "";
        const newVal = eventDetails[field] || "";
        return existingVal !== newVal;
      });

      if (otherFieldsChanged) {
        updateType = updateType ? "EVENT_UPDATED" : "EVENT_UPDATED";
      }

      // Send to SQS only if it was previously published
      if (updateType && wasPublished) {
        const sqsPayload = {
          eventId: uniqueEventID,
          eventType: updateType,
        };

        const sqsParams = {
          QueueUrl: process.env.EVENT_UPDATE_SQS_URL,
          MessageBody: JSON.stringify(sqsPayload),
        };

        try {
          const command = new SendMessageCommand(sqsParams);
          await sqsClient.send(command);
          console.log("Notification sent to SQS for:", updateType);
        } catch (err) {
          console.error("Failed to send SQS message:", err);
        }
      }

      // Helper to convert camelCase to PascalCase (used to match keys like EventTitle)
      function camelToPascal(str) {
        return str.charAt(0).toUpperCase() + str.slice(1);
      }
    }

    if (existingRecord.Item) {
      console.log("Event already exists. Updating...");
      const updateExpressionParts = [
        "EventTitle = :eventTitle",
        "EventDate = :eventDate",
        "EventLocation = :eventLocation",
        "EventDetails = :eventDetails",
        "EventImages = :eventImages",
        "CityID = :cityID",
        "CategoryID = :categoryID",
        "CategoryName = :categoryName",
        "EventType = :eventType",
        "Tags = :tags",
        "EventHighLight = :eventHighLight",
        "Price = :price",
        "Seats = :seats",
        "ReservedSeats = :reservedSeats",
        "AudienceBenefits = :audienceBenefits",
        "AdditionalInfo = :additionalInfo",
        //   "OrganizerName = :organizerName",
        "EventMode = :mode",
        //    "OrgID = :orgID",
        // "EventStatus = :eventStatus",
      ];

      const expressionAttributeValues = {
        ":eventTitle": { S: eventDetails.eventTitle || "" },
        ":eventDate": { S: eventDetails.dateTime || "" },
        ":eventLocation": { S: eventDetails.eventLocation || "" },
        ":eventDetails": { S: eventDetails.eventDetails || "" },
        ":eventImages": imageUrls.length
          ? { L: imageUrls.map((url) => ({ S: url })) }
          : { L: [] },
        ":cityID": { S: eventDetails.cityID || "" },
        ":categoryID": { S: eventDetails.categoryID || "" },
        ":categoryName": { S: eventDetails.categoryName || "" },
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
                  .filter((benefit) => benefit.trim() !== "")
                  .map((benefit) => ({
                    S: benefit,
                  })),
              }
            : { L: [] },
        ":additionalInfo": { S: eventDetails.additionalInfo || "" },
        //  ":organizerName": { S: eventDetails.OrganizerName || "" },
        ":mode": { S: eventDetails.eventMode || "" },
        //":orgID": { S: OrgID },
        //":eventStatus": { S: "AwaitingApproval" },
      };

      // Check if CollegeID is present
      if (eventDetails.collegeID) {
        updateExpressionParts.push("CollegeID = :collegeID");
        expressionAttributeValues[":collegeID"] = { S: eventDetails.collegeID };
      }

      const updateParams = {
        TableName: TABLE,
        Key: { EventID: { S: uniqueEventID } },
        UpdateExpression: `SET ${updateExpressionParts.join(", ")}`,
        ExpressionAttributeValues: expressionAttributeValues,
      };

      console.log("Update Params:", JSON.stringify(updateParams, null, 2));
      await dynamoDBClient.send(new UpdateItemCommand(updateParams));

      // Remove old images from S3 if they are not in DynamoDB
      const listParams = {
        Bucket: S3_BUCKET_NAME,
        Prefix: `event-images/${readableEventID}/`,
      };
      const listResponse = await s3Client.send(
        new ListObjectsV2Command(listParams)
      );
      console.log(listResponse);
      if (listResponse.Contents) {
        const keysToDelete = listResponse.Contents.filter(
          (item) => !imageUrls.some((url) => url.includes(item.Key))
        ).map((item) => ({ Key: item.Key }));

        console.log("KeystoDelete", keysToDelete);
        if (keysToDelete.length > 0) {
          const deleteParams = {
            Bucket: S3_BUCKET_NAME,
            Delete: { Objects: keysToDelete },
          };
          await s3Client.send(new DeleteObjectsCommand(deleteParams));
          console.log("Deleted old images from S3:", keysToDelete);
        }
      }

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
    console.error("Error details:", {
      message: error.message,
      stack: error.stack,
      event,
    });
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
    console.error("Error details:", {
      message: error.message,
      stack: error.stack,
    });
    throw new Error("Error generating ReadableEventID");
  }
};

export const getCollegeID = async (OrgID) => {
  if (!OrgID) {
    throw new Error("Organization ID (OrgID) is required.");
  }

  const ORGANIZER_TABLE = process.env.ORGANIZER_TABLE || "Organizer";
  if (!ORGANIZER_TABLE) {
    throw new Error("Missing required environment variable: ORGANIZER_TABLE.");
  }

  try {
    const params = {
      TableName: ORGANIZER_TABLE,
      Key: { OrganizerID: { S: OrgID } },
      ProjectionExpression: "collegeID",
    };

    const response = await dynamoDBClient.send(new GetItemCommand(params));
    return response.Item?.collegeID?.S || null;
  } catch (error) {
    console.error("Error fetching CollegeID:", error);
    console.error("Error details:", {
      message: error.message,
      stack: error.stack,
    });
    throw new Error("Failed to retrieve CollegeID from Organizer table.");
  }
};

const generateTagsFromTitle = (title = "", existingTags = "") => {
  const titleWords = title
    .toLowerCase()
    .replace(/[^\w\s]/gi, "") // remove punctuation
    .split(/\s+/); // split by whitespace

  const filteredWords = sw.removeStopwords(titleWords); // remove common stopwords

  const existing = existingTags
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag);

  const allTagsSet = new Set([...existing, ...filteredWords]);
  return Array.from(allTagsSet).join(","); // comma-separated string
};
