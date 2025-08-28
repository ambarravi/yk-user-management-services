import {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({ region: process.env.AWS_REGION });

const BOOKING_TABLE = "BookingDetails";
const EVENT_ID_INDEX = "EventID-index";

export const handler = async (event) => {
  for (const record of event.Records) {
    const eventName = record.eventName;

    if (eventName !== "MODIFY") continue;

    const newImage = record.dynamodb.NewImage;
    const oldImage = record.dynamodb.OldImage;

    const eventID = newImage.EventID.S;
    const newEventDate = newImage.EventDate?.S;
    const oldEventDate = oldImage?.EventDate?.S;

    // Get EventImages, ThumbnailImages, and EventStatus from both images
    const newEventImages = newImage.EventImages?.L?.map((item) => item.S) || [];
    const oldEventImages =
      oldImage?.EventImages?.L?.map((item) => item.S) || [];
    const newThumbnailImages =
      newImage.ThumbnailImages?.L?.map((item) => item.S) || [];
    const oldThumbnailImages =
      oldImage?.ThumbnailImages?.L?.map((item) => item.S) || [];
    const newEventStatus = newImage.EventStatus?.S;
    const oldEventStatus = oldImage?.EventStatus?.S;

    // Check if EventDate changed
    if (newEventDate === oldEventDate) {
      // Check if the only changes are to EventImages, ThumbnailImages, or EventStatus
      const eventImagesChanged =
        JSON.stringify(newEventImages) !== JSON.stringify(oldEventImages);
      const thumbnailImagesChanged =
        JSON.stringify(newThumbnailImages) !==
        JSON.stringify(oldThumbnailImages);
      const eventStatusChanged = newEventStatus !== oldEventStatus;

      // If only EventImages, ThumbnailImages, or EventStatus changed, skip processing
      if (eventImagesChanged || thumbnailImagesChanged || eventStatusChanged) {
        console.log({
          eventID,
          message:
            "Skipping update: Only EventImages, ThumbnailImages, or EventStatus changed",
        });
        continue;
      }

      // If no relevant attributes changed, skip
      console.log({
        eventID,
        message:
          "Skipping update: EventDate unchanged and no other relevant changes",
      });
      continue;
    }

    console.log(
      `EventDate changed for EventID: ${eventID}. Updating Bookings...`
    );

    try {
      // Query BookingDetails for matching EventID using index
      const bookings = await ddb.send(
        new QueryCommand({
          TableName: BOOKING_TABLE,
          IndexName: EVENT_ID_INDEX,
          KeyConditionExpression: "EventID = :eventId",
          ExpressionAttributeValues: {
            ":eventId": { S: eventID },
          },
        })
      );

      if (!bookings.Items || bookings.Items.length === 0) {
        console.warn(`No bookings found for EventID: ${eventID}`);
        continue;
      }

      for (const booking of bookings.Items) {
        const bookingId = booking.BookingID.S;

        await ddb.send(
          new UpdateItemCommand({
            TableName: BOOKING_TABLE,
            Key: { BookingID: { S: bookingId } },
            UpdateExpression: "SET EventDate = :newDate",
            ExpressionAttributeValues: {
              ":newDate": { S: newEventDate },
            },
            ConditionExpression: "attribute_exists(BookingID)",
          })
        );

        console.log(`Updated EventDate for BookingID: ${bookingId}`);
      }
    } catch (error) {
      console.error(`Error updating bookings for EventID ${eventID}`, error);
    }
  }
};
