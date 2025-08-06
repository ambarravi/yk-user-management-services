import {
  DynamoDBClient,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
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
 * Fetch Events using Query or Scan based on the SearchQuery option
 * @param {string} indexName - GSI to query
 * @param {object} keyCondition - KeyConditionExpression or Scan parameters
 * @param {boolean} useScan - Flag to indicate whether to use Scan (true) or Query (false)
 * @returns {Promise<Array>}
 */
const fetchEventsFromDDB = async (indexName, keyCondition, useScan = false) => {
  try {
    console.log("index name ", indexName);
    const params = {
      TableName: "EventDetails",
      IndexName: indexName,
      ExpressionAttributeValues: keyCondition.values,
      ScanIndexForward: true, // Sort events by date (oldest to newest)
    };

    if (useScan) {
      params.FilterExpression = keyCondition.filterexpression;
      if (keyCondition.names) {
        params.ExpressionAttributeNames = keyCondition.names; // Apply names for Scan
      }
    } else {
      console.log("Query block ", keyCondition.keyexpression);
      params.KeyConditionExpression = keyCondition.keyexpression;
      params.ExpressionAttributeNames = keyCondition.names || {};
    }

    console.log("Executing query with params:", JSON.stringify(params));

    // Use Scan or Query based on the flag
    const command = useScan
      ? new ScanCommand(params)
      : new QueryCommand(params);
    const { Items } = await client.send(command);

    // Convert DynamoDB records to JSON
    return Items ? Items.map((item) => unmarshall(item)) : [];
  } catch (error) {
    console.error("DynamoDB Error:", error);
    throw new Error("Failed to fetch events from DynamoDB");
  }
};

// /**
//  * Fetch events based on search query
//  * @param {string} searchQuery - User search input
//  * @returns {Promise<Array>}
//  */
// const searchEvents = async (searchQuery) => {
//   const indexes = [{ name: "EventDate-index", field: "Tags" }];

//   let allResults = [];

//   for (const index of indexes) {
//     const condition = {
//       filterexpression: `contains(${index.field}, :searchVal)`,
//       values: {
//         ":searchVal": { S: searchQuery },
//       },
//     };

//     const results = await fetchEventsFromDDB(index.name, condition, true);
//     allResults = allResults.concat(results);
//   }

//   // Deduplicate events based on EventID
//   const uniqueEvents = Array.from(
//     new Map(allResults.map((ev) => [ev.EventID, ev])).values()
//   );

//   return uniqueEvents;
// };

/**
 * Fetch events based on search query, respecting event type and college/city filters
 * @param {string} searchQuery - User search input
 * @param {string} [CityID] - Optional CityID to filter public events
 * @param {string} [CollegeID] - Optional CollegeID to filter private/inter events
 * @returns {Promise<Array>}
 */
const searchEvents = async (searchQuery, CityID, CollegeID) => {
  const getISTISOString = () => {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC + 5:30
    const istTime = new Date(now.getTime() + istOffset);
    return istTime.toISOString().slice(0, 16); // Keep till minutes like '2025-08-06T17:52'
  };

  let filterExpression = `contains(Tags, :searchVal) AND #EventStatus = :status AND #EventDate > :currentDate`;
  let expressionAttributeValues = {
    ":searchVal": { S: searchQuery },
    ":status": { S: "Published" },
    ":currentDate": { S: getISTISOString() },
  };
  let expressionAttributeNames = {
    "#EventStatus": "EventStatus",
    "#EventDate": "EventDate",
  };

  // Build filter expression based on CollegeID and CityID
  if (CollegeID) {
    // Students can see private events for their college, inter-college events, and public events
    filterExpression += ` AND (#EventType = :open OR (#EventType = :private AND #CollegeID = :collegeId) OR #EventType = :inter)`;
    expressionAttributeValues[":open"] = { S: "open" };
    expressionAttributeValues[":private"] = { S: "private" };
    expressionAttributeValues[":inter"] = { S: "inter" };
    expressionAttributeValues[":collegeId"] = { S: CollegeID };
    expressionAttributeNames["#EventType"] = "EventType";
    expressionAttributeNames["#CollegeID"] = "CollegeID";
  } else if (CityID) {
    // Non-students can only see public events in their city
    filterExpression += ` AND #EventType = :open AND #CityID = :cityId`;
    expressionAttributeValues[":open"] = { S: "open" };
    expressionAttributeValues[":cityId"] = { S: CityID };
    expressionAttributeNames["#EventType"] = "EventType";
    expressionAttributeNames["#CityID"] = "CityID";
  }

  const condition = {
    filterexpression: filterExpression,
    values: expressionAttributeValues,
    names: expressionAttributeNames, // Ensure names are included
  };

  // Use Scan on EventDate-index
  const results = await fetchEventsFromDDB("EventDate-index", condition, true);

  // Deduplicate events based on EventID
  const uniqueEvents = Array.from(
    new Map(results.map((ev) => [ev.EventID, ev])).values()
  );

  return uniqueEvents;
};

export const handler = async (event) => {
  let ParsedEvent;
  try {
    ParsedEvent = JSON.parse(event.body);
  } catch (error) {
    console.error("Error parsing event body:", error);
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid request body" }),
    };
  }
  console.log("Received Event:", ParsedEvent);

  const { CityID, CollegeID, SearchQuery } = ParsedEvent;
  let cityEvents = [];
  let cityEventFilter = [];
  let collegeEvents = [];
  let searchResults = [];
  let interCollegeEvents = [];
  let privateCollegeEvents = [];

  const getISTISOString = () => {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC + 5:30
    const istTime = new Date(now.getTime() + istOffset);
    return istTime.toISOString().slice(0, 16); // Keep till minutes like '2025-04-19T11:55'
  };

  try {
    if (SearchQuery) {
      searchResults = await searchEvents(SearchQuery, CityID, CollegeID);
    }
    if (CityID) {
      const cityCondition = {
        keyexpression: "#CityID = :cityId AND #EventDate > :currentDate",
        values: {
          ":cityId": { S: CityID },
          ":currentDate": { S: getISTISOString() },
        },
        names: {
          "#CityID": "CityID",
          "#EventDate": "EventDate",
        },
      };

      console.log("Call for City");
      console.log(cityCondition, "cityCondition");
      cityEvents = await fetchEventsFromDDB(
        "GSI_City_College_Date",
        cityCondition
      );
      cityEventFilter = cityEvents.filter(
        (ev) => ev.EventStatus === "Published" && ev.EventType === "open"
      );
    }

    if (CollegeID) {
      const collegeCondition = {
        keyexpression: "#CollegeID = :collegeId AND #EventDate > :currentDate",
        values: {
          ":collegeId": { S: CollegeID },
          ":currentDate": { S: getISTISOString() },
        },
        names: {
          "#CollegeID": "CollegeID",
          "#EventDate": "EventDate",
        },
      };

      collegeEvents = await fetchEventsFromDDB(
        "GSI_College_Date",
        collegeCondition
      );

      privateCollegeEvents = collegeEvents.filter(
        (ev) => ev.EventStatus === "Published" && ev.EventType === "private"
      );

      interCollegeEvents = collegeEvents.filter(
        (ev) => ev.EventStatus === "Published" && ev.EventType === "inter"
      );
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        CityEvents: CityID ? cityEventFilter.map(formatEventDetails) : [],
        PrivateCollegeEvents: CollegeID
          ? privateCollegeEvents.map(formatEventDetails)
          : [],
        InterCollegeEvents: CollegeID
          ? interCollegeEvents.map(formatEventDetails)
          : [],
        SearchResults: searchResults.map(formatEventDetails),
      }),
    };
  } catch (error) {
    console.error("Handler Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to process request" }),
    };
  }
};
