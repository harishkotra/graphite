// Echo-capture server: logs the request the gateway sends, replies with a valid judge JSON.
import http from "node:http";

const srv = http.createServer((req, res) => {
  let d = "";
  req.on("data", (c) => (d += c));
  req.on("end", () => {
    console.log("PATH:", req.url);
    console.log("AUTH:", req.headers.authorization ?? "(none)");
    const b = JSON.parse(d);
    console.log("MODEL:", b.model);
    console.log("MSG0.role:", b.messages[0].role);
    console.log("MSG0.content head:", JSON.stringify(String(b.messages[0].content).slice(0, 60)));
    console.log("MSG1.content head:", JSON.stringify(String(b.messages[1].content).slice(0, 60)));
    const reply = JSON.stringify({
      a: { insight: 1, clarity: 1, verdict: "x" },
      b: { insight: 1, clarity: 1, verdict: "y" },
      ship: "a",
      reason: "r",
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: reply } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
  });
});
srv.listen(8199, () => console.log("echo on 8199"));
