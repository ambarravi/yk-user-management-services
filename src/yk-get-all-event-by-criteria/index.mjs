import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

// AWS Region Configuration
const region = process.env.AWS_REGION || "eu-west-1";
const client = new DynamoDBClient({ region });

// Function to format event details for frontend
const formatEventDetails = (event) => ({
  id: event.EventID || "0",
  title: event.EventTitle || "Untitled Event",
  date: new Date(event.EventDate).toDateString(),
  time: new Date(event.EventDate).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }),
  location: event.EventLocation || "No Location",
  price: event.Price || "Free",
  about: event.EventDetails || "No description available.",
  benefits: event.AudienceBenefits || [],
  spl_banner: event.EventHighLight || "",
  images: event.EventImages ? event.EventImages.map((img) => img) : [],
  organizerName: event.OrganizerName || "",
  categoryName: event.CategoryName || "",
});

/**
 * Query DynamoDB for Events
 * @param {string} indexName - GSI to query (City/College)
 * @param {object} keyCondition - KeyConditionExpression
 * @param {object} lastEvaluatedKey - For pagination
 * @returns {Promise<{ events: Array, lastKey: object }>}
 */
const fetchEventsFromDDB = async (
  indexName,
  keyCondition,
  lastEvaluatedKey
) => {
  try {
    const params = {
      TableName: "EventDetails",
      IndexName: indexName,
      KeyConditionExpression: keyCondition.expression,
      ExpressionAttributeValues: keyCondition.values,
      ScanIndexForward: true, // Sort events by date (oldest to newest)
      ExclusiveStartKey: lastEvaluatedKey || undefined,
    };

    const { Items, LastEvaluatedKey } = await client.send(
      new QueryCommand(params)
    );

    // Convert DynamoDB records to JSON
    const events = Items ? Items.map((item) => unmarshall(item)) : [];

    return { events, lastKey: LastEvaluatedKey };
  } catch (error) {
    console.error("DynamoDB Query Error:", error);
    return { events: [], lastKey: null };
  }
};

export const handler = async (event) => {
  // console.log("Received Event:", JSON.stringify(event));
  let ParsedEvent = JSON.parse(event.body);
  console.log(ParsedEvent);

  const { CityID, CollegeID, CityLastEvaluatedKey, CollegeLastEvaluatedKey } =
    ParsedEvent;
  let cityEvents = [];
  let collegeEvents = [];
  console.log(CityID);
  // Fetch City-based events
  if (CityID) {
    const cityCondition = {
      expression: "CityID = :cityId AND EventDate > :currentDate",
      values: {
        ":cityId": { S: CityID },
        ":currentDate": { S: new Date().toISOString() },
      },
    };

    const { events, lastKey } = await fetchEventsFromDDB(
      "GSI_City_College_Date",
      cityCondition,
      CityLastEvaluatedKey
    );
    cityEvents = events.filter(
      (ev) =>
        ev.EventStatus === "Published" &&
        (ev.EventType === "open" || (CollegeID && ev.EventType === "inter"))
    );
  }

  // Fetch College-based events (if CollegeID is provided)
  if (CollegeID) {
    const collegeCondition = {
      expression: "CollegeID = :collegeId AND EventDate > :currentDate",
      values: {
        ":collegeId": { S: CollegeID },
        ":currentDate": { S: new Date().toISOString() },
      },
    };

    const { events, lastKey } = await fetchEventsFromDDB(
      "GSI_College_Date",
      collegeCondition,
      CollegeLastEvaluatedKey
    );
    collegeEvents = events.filter(
      (ev) =>
        ev.EventStatus === "Published" &&
        (ev.EventType === "inter" || ev.EventType === "private")
    );

    // Exclude CollegeEvents from CityEvents
    const collegeEventIDs = new Set(collegeEvents.map((ev) => ev.EventID));
    cityEvents = cityEvents.filter((ev) => !collegeEventIDs.has(ev.EventID));
  }

  // Format the response
  return {
    statusCode: 200,
    body: JSON.stringify({
      CityEvents: cityEvents.map(formatEventDetails),
      CollegeEvents: collegeEvents.map(formatEventDetails),
      CityLastEvaluatedKey: cityEvents.length > 0 ? CityLastEvaluatedKey : null,
      CollegeLastEvaluatedKey:
        collegeEvents.length > 0 ? CollegeLastEvaluatedKey : null,
    }),
  };
};
