import AWS from "aws-sdk";
import crypto from "crypto";

// Initialize AWS clients
const dynamodb = new AWS.DynamoDB.DocumentClient();
const REGION = process.env.AWS_REGION || "us-east-1";
const ses = new AWS.SES({ region: REGION });

// Configuration
const TABLE_NAME = "BookingOtpTable";
const OTP_LENGTH = 6;
const OTP_EXPIRY_MINUTES = 2;
const SENDER_EMAIL = "support@tikties.com";

// Generate a random OTP
function generateOtp(length = OTP_LENGTH) {
  const digits = "0123456789";
  let otp = "";
  for (let i = 0; i < length; i++) {
    otp += digits[crypto.randomInt(0, digits.length)];
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
    const response = await ses.sendEmail(params).promise();
    console.log(`Email sent to ${toEmail}, MessageId: ${response.MessageId}`);
    return true;
  } catch (error) {
    console.error(`Failed to send email: ${error.message}`);
    return false;
  }
}

// Store OTP in DynamoDB
async function storeOtp(email, otp) {
  const currentTime = Math.floor(Date.now() / 1000);
  const ttl = currentTime + OTP_EXPIRY_MINUTES * 60;
  const expTime = ttl;
  const params = {
    TableName: TABLE_NAME,
    Item: {
      email,
      otp,
      ttl,
      exp_time: expTime,
      created_at: currentTime,
    },
  };

  try {
    await dynamodb.put(params).promise();
    console.log(`OTP stored for ${email}`);
    return true;
  } catch (error) {
    console.error(`Failed to store OTP: ${error.message}`);
    return false;
  }
}

// Lambda Handler
export const handler = async (event) => {
  try {
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

      const otp = generateOtp();
      const stored = await storeOtp(email, otp);
      if (!stored) {
        return {
          statusCode: 500,
          body: JSON.stringify({ message: "Failed to store OTP" }),
        };
      }

      const sent = await sendEmail(email, otp);
      if (!sent) {
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
