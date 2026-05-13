#!/usr/bin/env node

/**
 * Simple test script for proxy detection and country lookup
 * Usage: node test-proxy.js <proxy-host> <proxy-port> [protocol]
 */

const axios = require("axios");
const { HttpProxyAgent } = require("http-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");

const [, , host, port, protocol = "http"] = process.argv;

if (!host || !port) {
  console.error("Usage: node test-proxy.js <host> <port> [protocol]");
  process.exit(1);
}

const CHECK_URL = "https://httpbin.org/ip";

async function testProxy() {
  console.log(`Testing proxy: ${protocol}://${host}:${port}`);

  try {
    // Build proxy URL
    const proxyUrl = `${protocol}://${host}:${port}`;
    let agent;

    if (protocol.startsWith("socks")) {
      agent = new SocksProxyAgent(proxyUrl);
    } else if (protocol === "https") {
      agent = new HttpsProxyAgent(proxyUrl);
    } else {
      agent = new HttpProxyAgent(proxyUrl);
    }

    const start = Date.now();
    const response = await axios.get(CHECK_URL, {
      timeout: 30000,
      httpAgent: agent,
      httpsAgent: agent,
      validateStatus: () => true,
    });
    const responseTime = Date.now() - start;

    console.log(`✓ Status: ${response.status}`);
    console.log(`✓ Response time: ${responseTime}ms`);
    console.log(`✓ Response data:`, response.data);

    if (response.status === 200 && response.data?.origin) {
      const ip = response.data.origin;
      console.log(`✓ Detected IP: ${ip}`);

      // Try to detect country
      try {
        const geoResponse = await axios.get(
          `https://ip-api.com/json?query=${ip}`,
          { timeout: 10000, validateStatus: () => true },
        );

        if (geoResponse.status === 200) {
          console.log(
            `✓ Country: ${geoResponse.data.countryCode || "Unknown"}`,
          );
          console.log(`✓ City: ${geoResponse.data.city || "Unknown"}`);
          console.log(`✓ ISP: ${geoResponse.data.isp || "Unknown"}`);
        }
      } catch (err) {
        console.log("✗ Country lookup failed:", err.message);
      }
    }
  } catch (err) {
    console.error("✗ Test failed:", err.message);
    process.exit(1);
  }
}

testProxy().then(() => {
  console.log("✓ Test completed");
  process.exit(0);
});
