import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { v4 as uuidv4 } from "uuid";

const ddbClient = new DynamoDBClient({
  region: process.env.AWS_REGION,
});
const sesClient = new SESClient({
  region: "eu-west-1",
});

// Get environment variables
const RETRY_COUNT = parseInt(process.env.RETRY_COUNT, 10) || 1;
const OTP_TABLE = process.env.OTP_TABLE || "BookingOtpTable";
const SENDER_EMAIL = process.env.SES_SENDER_EMAIL || "support@tikties.com";

// Get current time in IST
const getCurrentIST = () => {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000; // IST = UTC + 5.5 hrs
  return new Date(now.getTime() + istOffsetMs);
};

// Validate OTP from BookingOtpTable
const validateOtp = async (email, otp, retryCount = RETRY_COUNT) => {
  try {
    const command = new GetItemCommand({
      TableName: OTP_TABLE,
      Key: {
        email: { S: email },
        otp: { S: otp },
      },
    });
    const response = await ddbClient.send(command);
    if (!response.Item) {
      console.log(`Invalid OTP for ${email}`);
      return { valid: false, message: "Invalid OTP" };
    }
    const currentTime = Math.floor(Date.now() / 1000);
    const expTime = parseInt(response.Item.exp_time?.N || "0");
    if (currentTime > expTime) {
      console.log(`Expired OTP for ${email}`);
      return { valid: false, message: "OTP has expired" };
    }
    return { valid: true };
  } catch (error) {
    console.error(`Error validating OTP for ${email}:`, error);
    if (retryCount > 0) {
      console.log(
        `Retrying validateOtp for ${email} (${retryCount} retries left)...`
      );
      return validateOtp(email, otp, retryCount - 1);
    }
    throw new Error(`Failed to validate OTP: ${error.message}`);
  }
};

// Log notification to NotificationLogs with retry
const logNotification = async (
  notificationId,
  bookingId,
  userId,
  reminderType,
  retryCount = RETRY_COUNT
) => {
  try {
    const command = new PutItemCommand({
      TableName: "NotificationLogs",
      Item: {
        NotificationID: { S: notificationId },
        BookingID: { S: bookingId },
        UserID: { S: userId },
        ReminderType: { S: reminderType },
        Timestamp: { S: getCurrentIST().toISOString() },
      },
    });
    await ddbClient.send(command);
  } catch (error) {
    console.error(`Error logging notification ${notificationId}:`, error);
    if (retryCount > 0) {
      console.log(
        `Retrying logNotification for NotificationID ${notificationId} (${retryCount} retries left)...`
      );
      return logNotification(
        notificationId,
        bookingId,
        userId,
        reminderType,
        retryCount - 1
      );
    }
    throw new Error(
      `Failed to log notification ${notificationId}: ${error.message}`
    );
  }
};

// Check if notification was already sent with retry
const checkNotificationLog = async (
  notificationId,
  retryCount = RETRY_COUNT
) => {
  try {
    const command = new GetItemCommand({
      TableName: "NotificationLogs",
      Key: { NotificationID: { S: notificationId } },
    });
    const response = await ddbClient.send(command);
    return !!response.Item;
  } catch (error) {
    console.error(`Error checking notification log ${notificationId}:`, error);
    if (retryCount > 0) {
      console.log(
        `Retrying checkNotificationLog for NotificationID ${notificationId} (${retryCount} retries left)...`
      );
      return checkNotificationLog(notificationId, retryCount - 1);
    }
    throw new Error(
      `Failed to check notification log ${notificationId}: ${error.message}`
    );
  }
};

// Send confirmation email via SES with retry
const sendConfirmationEmail = async (email, retryCount = RETRY_COUNT) => {
  try {
    const command = new SendEmailCommand({
      Source: SENDER_EMAIL,
      Destination: {
        ToAddresses: [email.to],
      },
      Message: {
        Subject: {
          Data: email.subject,
        },
        Body: {
          Html: {
            Data: email.html,
          },
          Text: {
            Data: email.text,
          },
        },
      },
    });
    const response = await sesClient.send(command);
    console.log(
      `Confirmation email sent successfully to ${email.to}:`,
      response
    );
  } catch (error) {
    console.error(`Error sending confirmation email to ${email.to}:`, error);
    if (retryCount > 0) {
      console.log(
        `Retrying confirmation email send for ${email.to} (${retryCount} retries left)...`
      );
      return sendConfirmationEmail(email, retryCount - 1);
    }
    throw new Error(
      `Failed to send confirmation email to ${email.to}: ${error.message}`
    );
  }
};

export const handler = async (event) => {
  console.log(event);
  try {
    const requestBody = JSON.parse(event.body);
    const { bookingDetails } = requestBody;

    // Handle booking with OTP validation
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
      otp,
    } = bookingDetails || {};

    // Step 1: Validate input parameters
    if (
      !eventId ||
      !userId ||
      !ticketCount ||
      ticketCount <= 0 ||
      !bookingEmail ||
      !bookingName ||
      !otp
    ) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "Invalid booking details or OTP" }),
      };
    }

    // Step 2: Validate OTP
    const otpValidation = await validateOtp(bookingEmail, otp);
    if (!otpValidation.valid) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: otpValidation.message }),
      };
    }

    // Step 3: Check if the user already booked this event
    const existingBooking = await ddbClient.send(
      new QueryCommand({
        TableName: "BookingDetails",
        IndexName: "UserId-EventID-index",
        KeyConditionExpression: "EventID = :eventId AND UserId = :userId",
        FilterExpression: "BookingStatus = :completedStatus",
        ExpressionAttributeValues: {
          ":eventId": { S: eventId },
          ":userId": { S: userId },
          ":completedStatus": { S: "Completed" },
        },
      })
    );

    if (existingBooking.Count > 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: "User has already booked this event.",
        }),
      };
    }

    // Step 4: Fetch Event Details
    const eventDetails = await ddbClient.send(
      new GetItemCommand({
        TableName: "EventDetails",
        Key: { EventID: { S: eventId } },
      })
    );

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
    const eventTitle = eventDetails.Item.EventTitle.S;
    const eventDate = eventDetails.Item.EventDate.S;

    // Step 5: Check Seat Availability
    if (bookedSeats + ticketCount > totalSeats) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "Not enough seats available." }),
      };
    }

    // Step 6: Enhanced Transaction with UsersTable Update
    const bookingID = uuidv4();
    console.log("BookingID", bookingID);
    const createdAt = Math.floor(Date.now() / 1000);

    const capacity = Number(event.capacity ?? 0);

    const remainingSeats = capacity - bookedSeats;

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
              ":zero": { N: "0" },
              ":count": { N: ticketCount.toString() },
              ":remainingSeats": { N: remainingSeats.toString() },
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
              BookingContact: { S: contactNumber },
              TicketPrice: { N: ticketPrice.toString() },
              TotalAmountPaid: { N: totalPrice.toString() },
            },
          },
        },
        // Update UsersTable to increment eventsAttended
        {
          Update: {
            TableName: "UsersTable",
            Key: { UserID: { S: userId } },
            UpdateExpression:
              "SET eventsAttended = if_not_exists(eventsAttended, :zero) + :increment",
            ExpressionAttributeValues: {
              ":zero": { N: "0" },
              ":increment": { N: "1" },
            },
          },
        },
      ],
    });

    await ddbClient.send(transactionCommand);

    // Step 7: Send Confirmation Email
    const notificationId = `${bookingID}_booking_confirmation_email`;
    const reminderType = "booking_confirmation_email";

    // Check if email was already sent
    const emailSent = await checkNotificationLog(notificationId);
    if (emailSent) {
      console.log(`Skipping email for booking ${bookingID}: already sent`);
    } else {
      // Format EventDate for email (in IST)
      const eventDateTime = new Date(eventDate);
      const formattedEventDate = eventDateTime.toLocaleDateString("en-IN", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "Asia/Kolkata",
      });

      // Prepare email
      const email = {
        to: bookingEmail,
        subject: `Booking Confirmation for ${eventTitle}`,
        text: `Dear ${bookingName},\n\nThank you for booking ${ticketCount} ticket(s) for "${eventTitle}" on ${formattedEventDate}. Your booking ID is ${bookingID}. The total amount paid is ${totalPrice} INR.\n\nWe look forward to seeing you at the event! For any queries, please contact our support team at support@tikties.com.\n\nBest regards,\nThe Tiktie Team`,
        html: `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
              body {
                font-family: Arial, sans-serif;
                line-height: 1.6;
                color: #333;
                background-color: #f4f4f4;
                margin: 0;
                padding: 0;
              }
              .container {
                max-width: 600px;
                margin: 20px auto;
                background: #fff;
                padding: 20px;
                border-radius: 8px;
                box-shadow: 0 0 10px rgba(0,0,0,0.1);
              }
              .header {
                text-align: center;
                padding-bottom: 20px;
                border-bottom: 1px solid #ddd;
              }
              .header img {
                max-width: 150px;
                height: auto;
              }
              .content {
                padding: 20px 0;
              }
              .content p {
                margin: 10px 0;
              }
              .highlight {
                color: #007bff;
                font-weight: bold;
              }
              .footer {
                text-align: center;
                padding-top: 20px;
                border-top: 1px solid #ddd;
                font-size: 14px;
                color: #777;
              }
              .footer a {
                color: #007bff;
                text-decoration: none;
              }
              @media only screen and (max-width: 600px) {
                .container {
                  padding: 10px;
                }
                .header img {
                  max-width: 120px;
                }
              }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <img src="https://tikties-logo.s3.amazonaws.com/images/logo.png" alt="Tikties Logo">
                <h2>Booking Confirmation</h2>
              </div>
              <div class="content">
                <p>Dear <span class="highlight">${bookingName}</span>,</p>
                <p>Thank you for booking <span class="highlight">${ticketCount} ticket(s)</span> for "<span class="highlight">${eventTitle}</span>" scheduled on <span class="highlight">${formattedEventDate}</span>.</p>
                <p>Your booking ID is <span class="highlight">${bookingID}</span>.</p>
                <p>The total amount paid is <span class="highlight">${totalPrice} INR</span>.</p>
                <p>We look forward to seeing you at the event! For any queries, please contact our support team at <a href="mailto:support@tikties.com">support@tikties.com</a>.</p>
              </div>
              <div class="footer">
                <p>Best regards,<br>The Tiktie Team</p>
                <p><a href="mailto:support@tikties.com">support@tikties.com</a></p>
              </div>
            </div>
          </body>
          </html>
        `,
      };

      // Send email
      await sendConfirmationEmail(email);

      // Log email notification
      await logNotification(notificationId, bookingID, userId, reminderType);
    }

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

export const cancelBookingHandler = async (event) => {
  try {
    const requestBody = JSON.parse(event.body);
    const { bookingId, eventId, userId, ticketCount } = requestBody;

    if (!bookingId || !eventId || !userId || !ticketCount) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "Invalid cancellation details." }),
      };
    }

    const transactionCommand = new TransactWriteItemsCommand({
      TransactItems: [
        // Update EventDetails to reduce SeatsBooked
        {
          Update: {
            TableName: "EventDetails",
            Key: { EventID: { S: eventId } },
            UpdateExpression: "SET SeatsBooked = SeatsBooked - :count",
            ConditionExpression: "SeatsBooked >= :count",
            ExpressionAttributeValues: {
              ":count": { N: ticketCount.toString() },
            },
          },
        },
        // Update BookingDetails status to Cancelled
        {
          Update: {
            TableName: "BookingDetails",
            Key: { BookingID: { S: bookingId } },
            UpdateExpression: "SET BookingStatus = :cancelled",
            ConditionExpression: "BookingStatus = :completed",
            ExpressionAttributeValues: {
              ":cancelled": { S: "Cancelled" },
              ":completed": { S: "Completed" },
            },
          },
        },
        // Reduce eventsAttended count in UsersTable
        {
          Update: {
            TableName: "UsersTable",
            Key: { UserID: { S: userId } },
            UpdateExpression:
              "SET eventsAttended = eventsAttended - :decrement",
            ConditionExpression: "eventsAttended >= :decrement",
            ExpressionAttributeValues: {
              ":decrement": { N: "1" },
            },
          },
        },
      ],
    });

    await ddbClient.send(transactionCommand);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Booking cancelled successfully",
      }),
    };
  } catch (error) {
    console.error("Error cancelling booking:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Internal server error",
        error: error.message,
      }),
    };
  }
};
