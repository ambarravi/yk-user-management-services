import {
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const dynamodbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const snsClient = new SNSClient({ region: process.env.AWS_REGION });
const sesClient = new SESClient({ region: "eu-west-1" });

const { ORGANIZERS_TABLE, PLANS_TABLE, SNS_TOPIC_ARN, ADMIN_EMAIL } =
  process.env;

export const handler = async () => {
  try {
    // Get current date in IST
    const currentDate = new Date().toLocaleString("en-US", {
      timeZone: "Asia/Kolkata",
    });
    const currentTimestamp = new Date(currentDate).toISOString();

    // Fetch Free plan's EventsAllowed
    const plans = await getAllPlans();
    const freePlan = plans.find((plan) => plan.PlanID === "Free");
    if (!freePlan) {
      throw new Error("Free plan not found in Plans table");
    }
    const eventsAllowed = freePlan.EventsAllowed;

    // Fetch all organizers
    let organizers = [];
    let lastEvaluatedKey = null;
    do {
      const scanCommand = new ScanCommand({
        TableName: ORGANIZERS_TABLE,
        ProjectionExpression: "OrganizerID, LastResetDate",
        ExclusiveStartKey: lastEvaluatedKey,
      });
      const result = await dynamodbClient.send(scanCommand);
      organizers = organizers.concat(
        result.Items.map((item) => unmarshall(item))
      );
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    // Update organizers needing reset
    let resetCount = 0;
    for (const organizer of organizers) {
      const lastResetDate = organizer.LastResetDate
        ? new Date(organizer.LastResetDate)
        : null;
      const daysSinceLastReset = lastResetDate
        ? (new Date(currentDate) - lastResetDate) / (1000 * 60 * 60 * 24)
        : Infinity;

      if (!lastResetDate || daysSinceLastReset >= 28) {
        // Ensure reset only once per month
        const updateCommand = new UpdateItemCommand({
          TableName: ORGANIZERS_TABLE,
          Key: marshall({ OrganizerID: organizer.OrganizerID }),
          UpdateExpression:
            "SET eventsRemaining = :events, LastResetDate = :resetDate",
          ExpressionAttributeValues: marshall({
            ":events": eventsAllowed,
            ":resetDate": currentTimestamp,
          }),
        });
        await dynamodbClient.send(updateCommand);
        resetCount++;
      }
    }

    console.log(`Reset ${resetCount} organizers to ${eventsAllowed} events`);
    return { status: "success", resetCount };
  } catch (error) {
    console.error("Error during reset:", error);

    // Send SNS notification
    try {
      await snsClient.send(
        new PublishCommand({
          TopicArn: SNS_TOPIC_ARN,
          Message: `Tikties Event Reset Failed: ${error.message}`,
          Subject: "Tikties Event Reset Failure",
        })
      );
      console.log("SNS notification sent for reset failure");
    } catch (snsError) {
      console.error("Failed to send SNS notification:", snsError);
    }

    // Send SES email notification
    try {
      await sesClient.send(
        new SendEmailCommand({
          Source: ADMIN_EMAIL,
          Destination: { ToAddresses: [ADMIN_EMAIL] },
          Message: {
            Subject: { Data: "Tikties Event Reset Failure" },
            Body: {
              Text: {
                Data: `Error: ${
                  error.message
                }\nTime: ${new Date().toISOString()}\nPlease check CloudWatch logs for details.`,
              },
              Html: {
                Data: `
                  <h2>Tikties Event Reset Failure</h2>
                  <p><strong>Time:</strong> ${new Date().toISOString()}</p>
                  <p><strong>Error:</strong> ${error.message}</p>
                  <p><strong>Stack Trace:</strong><br>${error.stack.replace(
                    /\n/g,
                    "<br>"
                  )}</p>
                  <p>Please check CloudWatch logs for details.</p>
                  <p>Tikties Support</p>
                `,
              },
            },
          },
        })
      );
      console.log("SES email sent for reset failure");
    } catch (sesError) {
      console.error("Failed to send SES email:", sesError);
    }

    throw error;
  }
};

async function getAllPlans() {
  let plans = [];
  let lastEvaluatedKey = null;
  do {
    const scanCommand = new ScanCommand({
      TableName: PLANS_TABLE,
      FilterExpression: "IsActive = :active",
      ExpressionAttributeValues: marshall({ ":active": true }),
    });
    const result = await dynamodbClient.send(scanCommand);
    plans = plans.concat(result.Items.map((item) => unmarshall(item)));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return plans;
}
