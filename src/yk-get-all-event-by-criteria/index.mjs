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
    return [];
  }
};

/**
 * Fetch events based on search query
 * @param {string} searchQuery - User search input
 * @returns {Promise<Array>}
 */
const searchEvents = async (searchQuery) => {
  const indexes = [{ name: "EventDate-index", field: "Tags" }];

  let allResults = [];

  for (const index of indexes) {
    const condition = {
      filterexpression: `contains(${index.field}, :searchVal)`,
      values: {
        ":searchVal": { S: searchQuery },
      },
    };

    const results = await fetchEventsFromDDB(index.name, condition, true);
    allResults = allResults.concat(results);
  }

  // Deduplicate events based on EventID
  const uniqueEvents = Array.from(
    new Map(allResults.map((ev) => [ev.EventID, ev])).values()
  );

  return uniqueEvents;
};

export const handler = async (event) => {
  let ParsedEvent = JSON.parse(event.body);
  console.log("Received Event:", ParsedEvent);

  const { CityID, CollegeID, SearchQuery } = ParsedEvent;
  let cityEvents = [];
  let collegeEvents = [];
  let searchResults = [];
  let interCollegeEvents = [];
  let privateCollegeEvents = [];

  if (SearchQuery) {
    searchResults = await searchEvents(SearchQuery);
  }
  if (CityID) {
    const cityCondition = {
      keyexpression: "#CityID = :cityId AND #EventDate > :currentDate", // Use placeholders
      values: {
        ":cityId": { S: CityID },
        ":currentDate": { S: new Date().toISOString() },
      },
      names: {
        "#CityID": "CityID",
        "#EventDate": "EventDate",
      },
    };

    console.log("Call for CIty");
    console.log(cityCondition, "cityCondition");
    cityEvents = await fetchEventsFromDDB(
      "GSI_City_College_Date",
      cityCondition
    );
    cityEvents = cityEvents.filter(
      (ev) => ev.EventStatus === "Published" && ev.EventType === "open"
    );
  }

  if (CollegeID) {
    const collegeCondition = {
      keyexpression: "CollegeID = :collegeId AND EventDate > :currentDate",
      values: {
        ":collegeId": { S: CollegeID },
        ":currentDate": { S: new Date().toISOString() },
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
    interCollegeEvents = collegeEvents.filter(
      (ev) => ev.EventStatus === "Published" && ev.EventType === "inter"
    );
    privateCollegeEvents = collegeEvents.filter(
      (ev) => ev.EventStatus === "Published" && ev.EventType === "private"
    );
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      CityEvents: CityID ? cityEvents.map(formatEventDetails) : [],
      PrivateCollegeEvents: CollegeID
        ? privateCollegeEvents.map(formatEventDetails)
        : [],
      InterCollegeEvents: CollegeID
        ? interCollegeEvents.map(formatEventDetails)
        : [],
      SearchResults: searchResults.map(formatEventDetails),
    }),
  };
};
