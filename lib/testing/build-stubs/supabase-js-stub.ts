type QueryBuilder = {
  select: () => QueryBuilder;
  eq: () => QueryBuilder;
  maybeSingle: () => Promise<{ data: null }>;
};

function createQueryBuilder(): QueryBuilder {
  return {
    select: () => createQueryBuilder(),
    eq: () => createQueryBuilder(),
    maybeSingle: async () => ({ data: null }),
  };
}

export function createClient() {
  return {
    from: () => createQueryBuilder(),
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signOut: async () => ({}),
      getUser: async () => ({ data: { user: null } }),
    },
  };
}
