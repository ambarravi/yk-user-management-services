import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";

const dynamoDBClient = new DynamoDBClient({ region: process.env.AWS_REGION });

export const handler = async (event) => {
  try {
    console.log("Input event:", JSON.stringify(event));
    const REGION = process.env.AWS_REGION;
    const TABLE = process.env.ORGANIZER_TABLE;
    let body = JSON.parse(event.body);

    // Access the 'username' field
    let username = body.username;

    console.log("TABLE:", TABLE);

    const getParams = {
      TableName: TABLE,
      Key: {
        OrganizerID: {
          S: username,
        },
      },
    };

    console.log("Get params:", JSON.stringify(getParams));

    const existingRecord = await dynamoDBClient.send(
      new GetItemCommand(getParams)
    );

    console.log("Existing record:", existingRecord);

    // sample existing record

    // {
    //   '$metadata': {
    //     httpStatusCode: 200,
    //     requestId: 'PSBLJ36UETKJEQCCCEOJEAL7ONVV4KQNSO5AEMVJF66Q9ASUAAJG',
    //     extendedRequestId: undefined,
    //     cfId: undefined,
    //     attempts: 1,
    //     totalRetryDelay: 0
    //   },
    //   Item: {
    //     contactEmail: { S: 'ravi.ambar@gmail.com' },
    //     contactNumber: { S: '9860719197' },
    //     createdAt: { S: '2025-01-20T10:57:12.125Z' },
    //     OrganizerName: { S: 'Ravi' },
    //     alternateNumber: { S: '9860718184' },
    //     aboutOrganization: { S: 'About Organization:' },
    //     termsAccepted: { BOOL: true },
    //     logoPath: {
    //       S: 'https://tikto-orgnizer-dev.s3.eu-west-1.amazonaws.com/logo/google_115751856932696261052_Tikto_BG_web_5.png'
    //     },
    //     OrganizerID: { S: 'google_115751856932696261052' },
    //     contactPerson: { S: 'Ravichandra Ambar' }
    //   }
    // }

    //console.log("Logo key:", logoKey);

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
      body: JSON.stringify({
        record: existingRecord.Item,
      }),
    };
  } catch (error) {
    console.error("Error processing request:", error);
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
