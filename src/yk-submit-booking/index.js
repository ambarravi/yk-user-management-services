import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";

import { v4 as uuidv4 } from "uuid";

const ddbClient = new DynamoDBClient({ region: "eu-west-1" });

export const handler = async (event) => {
  console.log(event);
  try {
    const requestBody = JSON.parse(event.body);
    const {
      eventId,
      userId,
      bookingName,
      bookingEmail,
      ticketCount,
      ticketPrice,
      totalPrice,
      contactNumber,
      paymentMethod = "CASH",
    } = requestBody.bookingDetails;

    if (!eventId || !userId || !ticketCount || ticketCount <= 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "Invalid booking details." }),
      };
    }

    const bookingID = uuidv4();
    console.log("BookingID", bookingID);
    const createdAt = Math.floor(Date.now() / 1000); // Unix timestamp

    // **Step 1: Check if the user already booked this event**
    const existingBooking = await ddbClient.send(
      new QueryCommand({
        TableName: "BookingDetails",
        IndexName: "UserId-EventID-index", // Ensure this GSI exists
        KeyConditionExpression: "EventID  = :eventId AND UserId  = :userId",
        FilterExpression: "BookingStatus = :completedStatus", // Filters only "Completed" bookings
        ExpressionAttributeValues: {
          ":eventId": { S: eventId },
          ":userId": { S: userId },
          ":completedStatus": { S: "Completed" },
        },
      })
    );

    console.log("Existing booking completed ");

    if (existingBooking.Item) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: "User has already booked this event.",
        }),
      };
    } else {
      console.log("User Can book Ticket");
    }

    // **Step 2: Fetch Event Details to Check Seat Availability**
    const eventDetails = await ddbClient.send(
      new GetItemCommand({
        TableName: "EventDetails",
        Key: { EventID: { S: eventId } },
      })
    );

    console.log("Get event Details", eventDetails);
    if (!eventDetails.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ message: "Event not found." }),
      };
    }

    const totalSeats = parseInt(eventDetails.Item.Seats.N);
    const reservedSeats = parseInt(eventDetails.Item.ReservedSeats.N);
    const bookedSeats = eventDetails.Item.SeatsBooked?.N
      ? parseInt(eventDetails.Item.SeatsBooked.N)
      : 0;

    // **Step 3: Check Seat Availability**
    if (bookedSeats + ticketCount > totalSeats) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "Not enough seats available." }),
      };
    } else {
      console.log("Proceed  with seat booking ");
    }

    // **Step 4: Perform DynamoDB Transaction (Atomic Booking + Seat Update)**

    const transactionCommand = new TransactWriteItemsCommand({
      TransactItems: [
        // Update SeatsBooked in EventDetails
        {
          Update: {
            TableName: "EventDetails",
            Key: { EventID: { S: eventId } },
            UpdateExpression:
              "SET SeatsBooked = if_not_exists(SeatsBooked, :zero) + :count",
            ConditionExpression:
              "attribute_not_exists(SeatsBooked) OR SeatsBooked <= :remainingSeats",
            ExpressionAttributeValues: {
              ":zero": { N: "0" }, // Default value if SeatsBooked is missing
              ":count": { N: ticketCount.toString() },
              ":remainingSeats": { N: (totalSeats - ticketCount).toString() }, // Compute in backend
            },
          },
        },

        // Insert New Booking Record

        {
          Put: {
            TableName: "BookingDetails",
            Item: {
              BookingID: { S: bookingID },
              EventID: { S: eventId },
              UserId: { S: userId },
              OrganizerID: { S: eventDetails.Item.OrgID.S },
              BookingStatus: { S: "Completed" },
              BookingDate: { S: new Date().toISOString() },
              EventDate: { S: eventDetails.Item.EventDate.S },
              PaymentMethod: { S: paymentMethod },
              CreatedAt: { N: createdAt.toString() },
              SeatsBooked: { N: ticketCount.toString() },
              BookingName: { S: bookingName },
              BookingEmail: { S: bookingEmail },
              BookingEmail: { S: contactNumber },
              TicketPrice: { N: ticketPrice.toString() },
              TotalAmountPaid: { N: totalPrice.toString() },
            },
          },
        },
      ],
    });

    const transactionReult = await ddbClient.send(transactionCommand);
    console.log("Transaction Result");

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Booking successful",
        bookingID: bookingID,
      }),
    };
  } catch (error) {
    console.error("Error processing booking:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Internal server error",
        error: error.message,
      }),
    };
  }
};
