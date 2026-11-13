// @arcod generated: op remove · prompt e1583f4e5d6b · model qwen2.5-coder:7b
export async function remove(input, io) {
    const { id } = input;
    const rec = await io.load(id);
    if (!rec) return { error: 'NotFound' };
    await io.del(id);
    return { result: true };
}