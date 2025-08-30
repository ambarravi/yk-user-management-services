import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb"; // Import unmarshall utility

const region = process.env.AWS_REGION; // Default region
const dynamoDB = new DynamoDBClient({ region });

export async function handler(event) {
  function capitalizeCityName(cityName) {
    return cityName.charAt(0).toUpperCase() + cityName.slice(1).toLowerCase();
  }

  try {
    const params = {
      TableName: "City",
    };

    const result = await dynamoDB.send(new ScanCommand(params));

    // Convert DynamoDB AttributeValue format to plain JSON
    const cities = result.Items
      ? result.Items.map((item) => {
          const city = unmarshall(item);
          if (city.CityName) {
            city.CityName = capitalizeCityName(city.CityName); // Capitalize city name
          }
          return city;
        })
      : [];

    console.log("Query result:", cities);

    return {
      statusCode: 200,
      body: JSON.stringify(cities), // Return plain JSON
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*", // CORS headers
      },
    };
  } catch (error) {
    console.error("Error:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Could not fetch city suggestions" }),
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*", // CORS headers
      },
    };
  }
}
