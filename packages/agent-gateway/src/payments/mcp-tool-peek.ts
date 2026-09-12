export type McpRequestInspection = {
  isBatch: boolean;
  toolName: string | null;
  arguments: unknown;
};

export async function inspectMcpRequest(
  req: Pick<Request, "clone">,
): Promise<McpRequestInspection> {
  try {
    const body = await (req.clone() as Request).json();
    if (Array.isArray(body)) {
      return { isBatch: true, toolName: null, arguments: null };
    }
    if (
      body &&
      typeof body === "object" &&
      body.method === "tools/call" &&
      typeof body.params?.name === "string"
    ) {
      return {
        isBatch: false,
        toolName: body.params.name,
        arguments: body.params.arguments,
      };
    }
  } catch {
    return { isBatch: false, toolName: null, arguments: null };
  }
  return { isBatch: false, toolName: null, arguments: null };
}
