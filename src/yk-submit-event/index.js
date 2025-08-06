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

    // Log the client IP address for tracking
    const ipAddress = event.requestContext?.identity?.sourceIp || "unknown";
    console.log("Client IP Address:", ipAddress);

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
        : { L: [] },
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
                .filter((benefit) => benefit.trim() !== "")
                .map((benefit) => ({
                  S: benefit,
                })),
            }
          : { L: [] },
      AdditionalInfo: { S: eventDetails.additionalInfo || "" },
      OrganizerName: { S: eventDetails.OrganizerName || "" },
      EventMode: { S: eventDetails.eventMode || "" },
      EventStatus: { S: "AwaitingApproval" },
      OrganizerIp: { S: ipAddress }, // Add IP address to event payload
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
      const existingDate = existingRecord.Item.EventDate?.S;
      const newDate = eventDetails.dateTime;

      // Validate dates before comparison
      if (!existingDate || !newDate) {
        throw new Error(
          "Missing date information in existing or new event data"
        );
      }

      // Robust date comparison
      try {
        const existingDateObj = new Date(existingDate);
        const newDateObj = new Date(newDate);

        if (isNaN(existingDateObj.getTime()) || isNaN(newDateObj.getTime())) {
          throw new Error(
            `Invalid date format: existingDate=${existingDate}, newDate=${newDate}`
          );
        }

        // Compare dates up to minute precision
        const existingDateStr = existingDateObj.toISOString().slice(0, 16);
        const newDateStr = newDateObj.toISOString().slice(0, 16);

        console.log("existingDateStr", existingDateStr);
        console.log("newDateStr", newDateStr);

        if (existingDateStr !== newDateStr) {
          updateType = "RESCHEDULED";
        }
      } catch (dateError) {
        console.error("Date comparison error:", {
          message: dateError.message,
          existingDate,
          newDate,
        });
        throw dateError;
      }

      // Check for venue change
      if (
        !updateType &&
        existingRecord.Item.EventLocation?.S.trim() !==
          eventDetails.eventLocation.trim()
      ) {
        console.log(
          "Venue changed from",
          existingRecord.Item.EventLocation?.S,
          "to",
          eventDetails.eventLocation
        );
        updateType = "VENUE_CHANGED";
      }

      if (!updateType) {
        const otherFieldsChanged = [
          "eventTitle",
          "eventDetails",
          "highlight",
          "ticketPrice",
          "noOfSeats",
          "eventType",
          "categoryID",
          "categoryName",
          "cityID",
          "additionalInfo",
          "eventMode",
        ].some((field) => {
          const dynamoKey = camelToPascal(field);
          const existingVal =
            existingRecord.Item[dynamoKey]?.S ||
            existingRecord.Item[dynamoKey]?.N ||
            "";
          const newVal = eventDetails[field] || "";
          return existingVal !== newVal.toString();
        });

        if (otherFieldsChanged) {
          updateType = "EVENT_UPDATED";
        }
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

      // Helper to convert camelCase to PascalCase
      function camelToPascal(str) {
        return str.charAt(0).toUpperCase() + str.slice(1);
      }

      console.log("Event already exists. Updating...");
      let eventSt = existingRecord.Item.EventStatus.S.trim();
      if (eventSt !== "Published") {
        eventSt = "AwaitingApproval";
      }
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
        "EventMode = :mode",
        "EventStatus = :eventStatus",
        "OrganizerIp = :organizerIp", // Add IP address to update
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
        ":mode": { S: eventDetails.eventMode || "" },
        eventStatus: { S: eventSt },
        ":organizerIp": { S: ipAddress }, // Add IP address value
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
  const eventSequenceValue = "EventSequenceID";
  const tableName = "EventIDGenerator";

  try {
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
    .replace(/[^\w\s]/gi, "")
    .split(/\s+/);

  const filteredWords = sw.removeStopwords(titleWords);

  const existing = existingTags
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag);

  const allTagsSet = new Set([...existing, ...filteredWords]);
  return Array.from(allTagsSet).join(",");
};
