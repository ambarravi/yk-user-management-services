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
 * @param {string} indexName - GSI to query
 * @param {object} keyCondition - KeyConditionExpression
 * @returns {Promise<Array>}
 */
const fetchEventsFromDDB = async (indexName, keyCondition) => {
  try {
    const params = {
      TableName: "EventDetails",
      IndexName: indexName,
      KeyConditionExpression: keyCondition.expression,
      ExpressionAttributeValues: keyCondition.values,
      ScanIndexForward: true, // Sort events by date (oldest to newest)
    };

    const { Items } = await client.send(new QueryCommand(params));

    // Convert DynamoDB records to JSON
    return Items ? Items.map((item) => unmarshall(item)) : [];
  } catch (error) {
    console.error("DynamoDB Query Error:", error);
    return [];
  }
};

/**
 * Fetch events based on search query
 * @param {string} searchQuery - User search input
 * @returns {Promise<Array>}
 */
const searchEvents = async (searchQuery) => {
  const indexes = [
    { name: "GSI_EventName", field: "EventTitle" },
    { name: "GSI_Organizer", field: "OrganizerName" },
    { name: "GSI_Category", field: "CategoryName" },
    { name: "GSI_Tags", field: "Tags" },
  ];

  let allResults = [];

  for (const index of indexes) {
    const condition = {
      expression: `${index.field} = :searchVal AND EventDate > :currentDate`,
      values: {
        ":searchVal": { S: searchQuery },
        ":currentDate": { S: new Date().toISOString() },
      },
    };

    const results = await fetchEventsFromDDB(index.name, condition);
    allResults = allResults.concat(results);
  }

  // Deduplicate events
  const uniqueEvents = Array.from(
    new Map(allResults.map((ev) => [ev.EventID, ev])).values()
  );

  return uniqueEvents;
};

export const handler = async (event) => {
  let ParsedEvent = JSON.parse(event.body);
  console.log(ParsedEvent);

  const { CityID, CollegeID, SearchQuery } = ParsedEvent;
  let cityEvents = [];
  let collegeEvents = [];
  let searchResults = [];

  if (SearchQuery) {
    searchResults = await searchEvents(SearchQuery);
  } else {
    // Fetch City-based events
    if (CityID) {
      const cityCondition = {
        expression: "CityID = :cityId AND EventDate > :currentDate",
        values: {
          ":cityId": { S: CityID },
          ":currentDate": { S: new Date().toISOString() },
        },
      };

      cityEvents = await fetchEventsFromDDB(
        "GSI_City_College_Date",
        cityCondition
      );
      cityEvents = cityEvents.filter((ev) => ev.EventStatus === "Published");
    }

    // Fetch College-based events
    if (CollegeID) {
      const collegeCondition = {
        expression: "CollegeID = :collegeId AND EventDate > :currentDate",
        values: {
          ":collegeId": { S: CollegeID },
          ":currentDate": { S: new Date().toISOString() },
        },
      };

      collegeEvents = await fetchEventsFromDDB(
        "GSI_College_Date",
        collegeCondition
      );
      collegeEvents = collegeEvents.filter(
        (ev) => ev.EventStatus === "Published"
      );

      // Remove duplicates from cityEvents
      const collegeEventIDs = new Set(collegeEvents.map((ev) => ev.EventID));
      cityEvents = cityEvents.filter((ev) => !collegeEventIDs.has(ev.EventID));
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      CityEvents: cityEvents.map(formatEventDetails),
      CollegeEvents: collegeEvents.map(formatEventDetails),
      SearchResults: searchResults.map(formatEventDetails),
    }),
  };
};
