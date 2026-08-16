# Namecheap Domain Delegation

## 1. Acquire Cloudflare Coordinates

1. Open the [Cloudflare Dashboard](https://dash.cloudflare.com) and click **Add Site**.
2. Provide your Namecheap-managed URL and select the **Free plan**.
3. Allow Cloudflare to ingest your previous records.
4. Note the two **Cloudflare Nameservers** provided on the final screen.

## 2. Reconfigure Namecheap Custom DNS

1. Sign in to your [Namecheap Account](https://www.namecheap.com/myaccount/login/).
2. In the left-hand sidebar, select **Domain List**.
3. Find your domain and click the **Manage** button on the far right.
4. Under the **Domain** tab (this is the default landing tab when managing a domain), scroll down to the **Nameservers** section.
5. In the dropdown menu (which normally defaults to "Namecheap BasicDNS"), select **Custom DNS**.
6. Two input fields will instantly appear.
7. Paste the first Cloudflare Nameserver into **Nameserver 1**.
8. Paste the second Cloudflare Nameserver into **Nameserver 2**.
9. **Critical Step:** You must click the **Green Checkmark (💾)** on the right side of the input row to actively save the changes. If you navigate away without hitting the checkmark, the change rolls back instantly.

## 3. Verify Takeover

Head back to Cloudflare and trigger the nameserver verification check. Namecheap propagation typically executes very reliably, but expect standard global DNS delays.
