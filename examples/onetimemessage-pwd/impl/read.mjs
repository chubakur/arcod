export async function read(input, io) {
    const { id, password } = input;
    let rec = await io.load(id);
    if (!rec) return (await io.seen(id)) ? { error: "Gone" } : { error: "NotFound" };
    if (rec.h && !(await io.verify(password, rec.h))) return { error: "WrongPassword" };
    if (!(await io.takeIf(id, rec))) return { error: "Gone" };
    return { result: rec.b };
}