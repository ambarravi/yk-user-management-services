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
    const newEventDate = newImage.EventDate.S;
    const oldEventDate = oldImage?.EventDate?.S;

    // Only proceed if EventDate changed
    if (newEventDate === oldEventDate) continue;

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
