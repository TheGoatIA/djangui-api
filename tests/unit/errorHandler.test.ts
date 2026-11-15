import errorHandler from '../../src/middleware/errorHandler';

const run = (err: any, env = 'production') => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = env;
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  errorHandler(err, {} as any, res, jest.fn());
  process.env.NODE_ENV = prev;
  return res;
};

describe('errorHandler — erreurs client des body-parsers', () => {
  it('JSON malformé -> 400 (et non 500)', () => {
    const e: any = new SyntaxError('Unexpected token');
    Object.assign(e, { status: 400, statusCode: 400, expose: true, type: 'entity.parse.failed' });
    const res = run(e);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toMatch(/JSON invalide/);
  });

  it('corps trop volumineux -> 413', () => {
    const e: any = new Error('request entity too large');
    Object.assign(e, { status: 413, statusCode: 413, expose: true, type: 'entity.too.large' });
    expect(run(e).status).toHaveBeenCalledWith(413);
  });

  it('une vraie erreur serveur reste un 500 générique', () => {
    const res = run(new Error('db exploded'));
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0].message).toBe('Something went very wrong!');
  });
});
