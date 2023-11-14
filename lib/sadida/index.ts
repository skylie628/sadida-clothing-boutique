import { SHOPIFY_GRAPHQL_API_ENDPOINT, TAGS } from "../constants";
import { ensureStartsWith } from "../utils";
import { getMenuQuery } from "./queries/menu";
import {
  TypedDocumentString,
  GetMenuBySlugDocument,
  GetCollectionProductsBySlugDocument,
  GetCategoryProductsBySlugDocument,
  MenuItemFragment,
  ProductOrderField,
  OrderDirection,
  ProductMediaType,
} from "./generated/graphql";
import { saleorProductToSadidaProduct } from "./mapper";
import { invariant } from "./utils";
//types
import { Menu, Product } from "./types";
const endpoint = process.env.SALEOR_INSTANCE_URL;
invariant(endpoint, `Missing SALEOR_INSTANCE_URL!`);
type GraphQlError = {
  message: string;
};
type GraphQlErrorRespone<T> = { data: T } | { errors: readonly GraphQlError[] };
export async function saleorFetch<Result, Variables>({
  query,
  variables,
  headers,
  cache,
  tags,
}: {
  query: TypedDocumentString<Result, Variables>;
  variables: Variables;
  headers?: HeadersInit;
  cache?: RequestCache;
  tags?: NextFetchRequestConfig["tags"];
}): Promise<Result> {
  invariant(endpoint, `Missing SALEOR_INSTANCE_URL!`);

  const options = cache
    ? { cache, next: { tags } }
    : { next: { revalidate: 900, tags } };
  const result = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      query: query.toString(),
      ...(variables && { variables }),
    }),
    ...options,
  });

  const body = (await result.json()) as GraphQlErrorRespone<Result>;

  if ("errors" in body) {
    throw body.errors[0];
  }

  return body.data;
}

type MenuItemWithChildren = MenuItemFragment & {
  children?: null | undefined | MenuItemWithChildren[];
};
function flattenMenuItems(
  menuItems: null | undefined | MenuItemWithChildren[]
): Menu[] {
  return (
    menuItems?.flatMap((item) => {
      // Remove empty categories and collections from menu
      if (item.category && !item.category.products?.totalCount) {
        return [];
      }
      if (item.collection && !item.collection.products?.totalCount) {
        return [];
      }

      const path =
        item.url ||
        (item.collection
          ? `/search/${item.collection.slug}`
          : item.category
          ? `/search/${item.category.slug}`
          : "");

      return [
        ...(path
          ? [
              {
                path: path,
                title: item.name,
              },
            ]
          : []),
        ...flattenMenuItems(item.children),
      ];
    }) || []
  );
}
const _getCollectionProducts = async ({
  collection,
  reverse,
  sortKey,
}: {
  collection: string;
  reverse?: boolean;
  sortKey?: ProductOrderField;
}) => {
  const fetched = await saleorFetch({
    query: GetCollectionProductsBySlugDocument,
    variables: {
      slug: collection,
      sortBy:
        sortKey === ProductOrderField.Rank
          ? ProductOrderField.Rating
          : sortKey || ProductOrderField.Rating,
      sortDirection: reverse ? OrderDirection.Desc : OrderDirection.Asc,
    },
    tags: [TAGS.collections, TAGS.products],
  });
  if (fetched.collection) {
    return fetched.collection;
  }
};

const _getCategoryProducts = async ({
  category,
  reverse,
  sortKey,
}: {
  category: string;
  reverse?: boolean;
  sortKey?: ProductOrderField;
}) =>
  (
    await saleorFetch({
      query: GetCategoryProductsBySlugDocument,
      variables: {
        slug: category,
        sortBy:
          sortKey === ProductOrderField.Rank
            ? ProductOrderField.Rating
            : sortKey || ProductOrderField.Rating,
        sortDirection: reverse ? OrderDirection.Desc : OrderDirection.Asc,
      },
      tags: [TAGS.collections, TAGS.products],
    })
  ).category;
export async function getCollectionProducts({
  collection,
  reverse,
  sortKey,
}: {
  collection: string;
  reverse?: boolean;
  sortKey?: ProductOrderField;
}): Promise<Product[]> {
  if (typeof reverse === "undefined" && typeof sortKey === "undefined") {
    reverse = true;
    sortKey = ProductOrderField.Name;
  }

  const saleorCollectionProducts =
    (await _getCollectionProducts({
      collection,
      reverse,
      sortKey,
    })) ||
    (await _getCategoryProducts({
      category: collection,
      reverse,
      sortKey,
    }));
  if (!saleorCollectionProducts) {
    throw new Error(`Collection not found: ${collection}`);
  }

  return (
    saleorCollectionProducts.products?.edges.map((product) =>
      saleorProductToSadidaProduct(product.node)
    ) || []
  );
}

// PRODUCTS
export type GetProductBySlugQuery = {
  product?: {
    id: string;
    slug: string;
    name: string;
    isAvailableForPurchase?: boolean | null;
    description?: string | null;
    seoTitle?: string | null;
    seoDescription?: string | null;
    updatedAt: string;
    pricing?: {
      priceRange?: {
        start?: { gross: { currency: string; amount: number } } | null;
        stop?: { gross: { currency: string; amount: number } } | null;
      } | null;
    } | null;
    media?: Array<{ url: string; type: ProductMediaType; alt: string }> | null;
    collections?: Array<{ name: string }> | null;
    variants?: Array<{
      id: string;
      name: string;
      attributes: Array<{
        attribute: {
          slug?: string | null;
          name?: string | null;
          choices?: { edges: Array<{ node: { name?: string | null } }> } | null;
        };
        values: Array<{ name?: string | null }>;
      }>;
      pricing?: {
        price?: { gross: { currency: string; amount: number } } | null;
      } | null;
    }> | null;
  } | null;
};

export async function getMenu(handle: string): Promise<Menu[]> {
  const handleToSlug: Record<string, string> = {
    "next-js-frontend-footer-menu": "footer",
    "next-js-frontend-header-menu": "navbar",
  };
  const saleorMenu = await saleorFetch({
    query: GetMenuBySlugDocument,
    variables: {
      slug: handleToSlug[handle] || handle,
    },
  });

  if (!saleorMenu.menu) {
    throw new Error(`Menu not found: ${handle}`);
  }

  const saleorUrl = new URL(endpoint!);
  saleorUrl.pathname = "";

  const result = flattenMenuItems(saleorMenu.menu.items)
    .filter(
      // unique by path
      (item1, idx, arr) =>
        arr.findIndex((item2) => item2.path === item1.path) === idx
    )
    .map((item) => ({
      ...item,
      path: item.path.replace(
        "http://localhost:8000",
        saleorUrl.toString().slice(0, -1)
      ),
    }));

  if (handle === "next-js-frontend-header-menu") {
    // limit number of items in header to 3
    return result.slice(0, 3);
  }
  return result;
}
