### Overview
A proxy server that tracks bandwidth usage and site analytics

There is a Real-time metrics endpoint (GET /metrics) which is not protected by the proxy basic auth
Response looks like the example below
```
{
  "bandwidth_usage": "125MB",
  "top_sites": [
    {"url": "example.com", "visits": 10},
    {"url": "google.com", "visits": 5}
  ]
}
```
The server also shows in the console the summary above during shuts down


### Installation / Project setup
Built with the bun run time
```bash
$ bun install 
```

## Run tests

```bash
$ bun test
```