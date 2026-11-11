export async function read(input, io) {
    const { id } = input;
    let rec = await io.load(id);
    if (!rec) return (await io.seen(id)) ? { error: "Gone" } : { error: "NotFound" };
    if (!(await io.takeIf(id, rec))) return { error: "Gone" };
    return { result: rec.b };
}