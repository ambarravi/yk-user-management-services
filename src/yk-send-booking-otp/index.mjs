import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { randomInt } from "crypto";

// Initialize AWS clients
const REGION = process.env.AWS_REGION || "us-east-1";
const dynamoDBClient = new DynamoDBClient({ region: REGION });
const dynamodb = DynamoDBDocumentClient.from(dynamoDBClient);
const ses = new SESClient({ region: REGION });

// Configuration
const TABLE_NAME = "BookingOtpTable";
const OTP_LENGTH = 6;
const OTP_EXPIRY_MINUTES = 2; // 2 minutes expiry
const SENDER_EMAIL = "support@tikties.com"; // Replace with your verified SES sender email

// Generate a random OTP
function generateOtp(length = OTP_LENGTH) {
  const digits = "0123456789";
  let otp = "";
  for (let i = 0; i < length; i++) {
    otp += digits[randomInt(0, digits.length)];
  }
  return otp;
}

// Send OTP via email using AWS SES
async function sendEmail(toEmail, otp) {
  const params = {
    Source: SENDER_EMAIL,
    Destination: { ToAddresses: [toEmail] },
    Message: {
      Subject: { Data: "Your Tikties Booking OTP", Charset: "UTF-8" },
      Body: {
        Text: {
          Data: `Your OTP for booking verification is ${otp}. It is valid for ${OTP_EXPIRY_MINUTES} minutes.`,
          Charset: "UTF-8",
        },
      },
    },
  };

  try {
    const response = await ses.send(new SendEmailCommand(params));
    console.log(`Email sent to ${toEmail}, MessageId: ${response.MessageId}`);
    return true;
  } catch (error) {
    console.error(`Failed to send email: ${error.message}`);
    return false;
  }
}

// Store OTP in DynamoDB with TTL and explicit expiration time
async function storeOtp(email, otp) {
  const currentTime = Math.floor(Date.now() / 1000); // Current time in seconds
  const ttl = currentTime + OTP_EXPIRY_MINUTES * 60; // TTL 2 minutes from now
  const expTime = currentTime + OTP_EXPIRY_MINUTES * 60; // Explicit expiration 2 minutes from now
  const params = {
    TableName: TABLE_NAME,
    Item: {
      email: email,
      otp: otp,
      ttl: ttl, // DynamoDB TTL attribute
      exp_time: expTime, // Explicit expiration time for validation
      created_at: currentTime,
    },
  };

  try {
    await dynamodb.send(new PutCommand(params));
    console.log(`OTP stored for ${email}`);
    return true;
  } catch (error) {
    console.error(`Failed to store OTP: ${error.message}`);
    return false;
  }
}

// Lambda handler
export const handler = async (event) => {
  try {
    console.log("event", event);
    const body = JSON.parse(event.body || "{}");
    const path = event.path || "";

    if (path.includes("send-booking-otp")) {
      const email = body.email;
      if (!email) {
        console.log("Email is required");
        return {
          statusCode: 400,
          body: JSON.stringify({ message: "Email is required" }),
        };
      }

      // Generate and store OTP
      const otp = generateOtp();
      if (!(await storeOtp(email, otp))) {
        console.error("Failed to store OTP");
        return {
          statusCode: 500,
          body: JSON.stringify({ message: "Failed to store OTP" }),
        };
      }

      // Send OTP via email
      if (!(await sendEmail(email, otp))) {
        console.error("Failed to send OTP");
        return {
          statusCode: 500,
          body: JSON.stringify({ message: "Failed to send OTP" }),
        };
      }

      console.log("OTP sent successfully");
      return {
        statusCode: 200,
        body: JSON.stringify({ message: "OTP sent successfully" }),
      };
    } else {
      console.log("Invalid endpoint");
      return {
        statusCode: 404,
        body: JSON.stringify({ message: "Invalid endpoint" }),
      };
    }
  } catch (error) {
    console.error(`Error processing request: ${error.message}`);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Internal server error" }),
    };
  }
};
