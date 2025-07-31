import {
  RekognitionClient,
  DetectModerationLabelsCommand,
} from "@aws-sdk/client-rekognition";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import {
  DynamoDBClient,
  UpdateItemCommand,
  QueryCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { v4 as uuidv4 } from "uuid";

const rekognition = new RekognitionClient({});
const s3 = new S3Client({});
const ddb = new DynamoDBClient({});
const ses = new SESClient({});

const LOGO_URL = "https://tikties-logo.s3.amazonaws.com/images/logo.png";

export const handler = async (event) => {
  for (const record of event.Records) {
    try {
      const bucket = record.s3.bucket.name;
      const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

      // Rekognition check
      const moderationResult = await rekognition.send(
        new DetectModerationLabelsCommand({
          Image: { S3Object: { Bucket: bucket, Name: key } },
          MinConfidence: 80,
        })
      );

      console.log(
        "Moderation Labels:",
        JSON.stringify(moderationResult.ModerationLabels, null, 2)
      );

      const BLOCKED_LABELS = [
        "explicit nudity",
        "suggestive",
        "partial nudity",
        "female swimwear or underwear",
        "male swimwear or underwear",
        "sexual situations",
        "graphic violence",
        "violence",
        "revealing clothes",
      ];

      const flagged = moderationResult.ModerationLabels?.some((label) => {
        const name = label.Name?.toLowerCase();
        const parent = label.ParentName?.toLowerCase();
        return BLOCKED_LABELS.includes(name) || BLOCKED_LABELS.includes(parent);
      });

      if (!flagged) {
        console.log(`Image ${key} passed moderation.`);
        continue;
      }

      // Delete image
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      console.log(`Deleted ${key} due to policy violation.`);

      // Extract EventID from folder path
      const match = key.match(/event-images\/(EVT-[^/]+)\//);
      console.log("match", match);
      const readableEventID = match?.[1];
      if (!readableEventID) throw new Error("EventID not found in key");

      // Get EventDetails
      const eventDetailsRes = await ddb.send(
        new QueryCommand({
          TableName: "EventDetails",
          IndexName: "ReadableEventID-index",
          KeyConditionExpression: "ReadableEventID = :eid",
          ExpressionAttributeValues: {
            ":eid": { S: readableEventID },
          },
        })
      );

      const eventItem = eventDetailsRes.Items?.[0];
      console.log("eventItem", eventItem);
      if (!eventItem) throw new Error("Event not found");

      const EventID = eventItem.EventID.S;
      const EventTitle = eventItem.EventTitle.S;
      const OrganizerID = eventItem.OrgID.S;

      // Update status to UnderReview
      let eventDetailsUpdate = await ddb.send(
        new UpdateItemCommand({
          TableName: "EventDetails",
          Key: { EventID: { S: EventID } },
          UpdateExpression: "SET #s = :r",
          ExpressionAttributeNames: { "#s": "Status" },
          ExpressionAttributeValues: { ":r": { S: "UnderReview" } },
        })
      );
      console.log("eventDetailsUpdate", eventDetailsUpdate);

      // Get Organizer Email
      const orgRes = await ddb.send(
        new QueryCommand({
          TableName: "Organizer",
          KeyConditionExpression: "OrganizerID = :oid",
          ExpressionAttributeValues: {
            ":oid": { S: OrganizerID },
          },
        })
      );

      console.log("orgRes", orgRes);

      const contactEmail = orgRes.Items?.[0]?.contactEmail?.S;
      console.log("contactEmail", contactEmail);
      if (!contactEmail) throw new Error("Organizer contactEmail not found");

      // Send Email via SES
      const subject = `Violation of Policy - Event ${EventTitle} Under Review`;
      const htmlBody = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><div style="background:#fff;padding:30px;font-family:Arial;max-width:600px;margin:auto;border-radius:8px;box-shadow:0 2px 6px rgba(0,0,0,0.1)"><img src='${LOGO_URL}' style="max-width:120px;display:block;margin:0 auto 20px"/><h2 style="text-align:center">${subject}</h2><p>This is to inform you that your application to host event <strong>${EventTitle}</strong> is under review because an uploaded image was rejected by our system. Your event is currently marked <strong>Under Review</strong>.</p><div style="margin-top:40px;font-size:12px;color:#999;text-align:center">You are receiving this email as part of your event participation.<br/>For support, contact us at support@tikties.com</div></div></body></html>`;

      await ses.send(
        new SendEmailCommand({
          Destination: { ToAddresses: [contactEmail] },
          Message: {
            Subject: { Data: subject },
            Body: {
              Html: { Data: htmlBody },
            },
          },
          Source: "support@tikties.com",
        })
      );

      // Log Notification
      const notificationID = `EMAIL_${EventID}_${OrganizerID}_UNDER_REVIEW`;
      const timestamp = new Date().toISOString();
      const ttl = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days

      let notificationResult = await ddb.send(
        new PutItemCommand({
          TableName: "NotificationLogs",
          Item: {
            NotificationID: { S: notificationID },
            BookingID: { S: "" },
            EventID: { S: EventID },
            EventType: { S: "EMAIL_UNDER_REVIEW" },
            SendCount: { N: "1" },
            Timestamp: { S: timestamp },
            TTL: { N: ttl.toString() },
            UserID: { S: OrganizerID },
          },
        })
      );

      console.log("notificationResult", notificationResult);
    } catch (err) {
      console.error("Error processing image:", err);
    }
  }
  return { statusCode: 200 };
};
