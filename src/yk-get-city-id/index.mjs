import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const region = process.env.AWS_REGION || "eu-west-1"; // Default region
const dynamoDB = new DynamoDBClient({ region });

export async function handler(event) {
  // Normalize city name to lowercase for consistent matching
  function normalizeCityName(cityName) {
    if (!cityName) return "";
    return cityName.toLowerCase(); // Match DynamoDB's lowercase convention
  }

  try {
    // Parse the event body to get the city name
    const body = event.body ? JSON.parse(event.body) : {};
    const cityName = body.city?.trim();
    if (!cityName) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "City name is required in the request body",
        }),
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      };
    }

    const normalizedCityName = normalizeCityName(cityName);

    // Scan the City table
    const params = {
      TableName: "City",
    };

    const result = await dynamoDB.send(new ScanCommand(params));

    // Convert DynamoDB items to plain JSON
    const cities = result.Items
      ? result.Items.map((item) => unmarshall(item))
      : [];

    // Find the city matching the provided name
    const matchedCity = cities.find(
      (city) =>
        city.CityName && normalizeCityName(city.CityName) === normalizedCityName
    );

    if (!matchedCity || !matchedCity.CityID) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: `City '${cityName}' not found` }),
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      };
    }

    // Return only the CityID
    return {
      statusCode: 200,
      body: JSON.stringify({ cityId: matchedCity.CityID }),
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    };
  } catch (error) {
    console.error("Error fetching CityID:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Could not fetch CityID" }),
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    };
  }
}
