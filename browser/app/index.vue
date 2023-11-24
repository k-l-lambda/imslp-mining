<template>
	<div>
		<header>
			<datalist id="workid-list">
				<option v-for="id of workIdList" :key="id" :value="id" />
			</datalist>
			&#x1f4d5; <input class="work-id" type="text" v-model.lazy="workId" list="workid-list" placeholder="Work ID" />
		</header>
		<main>
			<div v-if="workInfo">
				<h2>
					<em class="author">{{workInfo.author}}</em>
					<strong class="title">{{workInfo.title}}</strong>
					<a :href="workInfo.url" target="_blank">&#x1f517;</a>
				</h2>
				<pre class="work-names" v-if="workNames" v-text="workNames"></pre>
				<ul class="file-list">
					<li v-for="file of workInfo.files" :key="file.id">
						<h3 class="file-id"><em>{{file.id}}</em></h3>
						<p>
							<i>{{iconForFile(file)}}</i>
							<a :href="'/imslp/' + file.path" target="_blank">{{file.path.split("/").pop()}}</a>
						</p>
					</li>
				</ul>
			</div>
		</main>
	</div>
</template>

<style scoped>
	header
	{
		font-size: 180%;
	}

	header input
	{
		font-size: 150%;
	}

	h2
	{
		padding: 0 2em;
	}

	h2 a
	{
		text-decoration: none;
	}

	.author
	{
		display: inline-block;
		font-weight: normal;
	}

	.title
	{
		margin: 0 1.2em;
	}

	.work-names
	{
		margin: 4em;
		font-size: 120%;
		float: right;
	}

	li h3
	{
		margin: 0;
		display: inline-block;
	}

	.file-list li
	{
		margin: 0 0 2em;
	}

	.file-list li i
	{
		display: inline-block;
		margin: 0 .5em;
		font-style: normal;
	}

	.file-id::before
	{
		content: "#";
		font-weight: normal;
		color: #aaa;
	}
</style>

<script setup>
	import { ref, computed, onMounted, watch } from "vue";


	const workIdList = ref([]);
	const workId = ref("");

	const workInfo = ref(null);

	const workNames = computed(() => {
		if (!workInfo.value || !workInfo.value.meta || !workInfo.value.meta["Name Translations"])
			return;

		return workInfo.value.meta["Name Translations"].split("; ").join("\n");
	});


	onMounted(async () => {
		const response = await fetch("/workid-list");
		workIdList.value = await response.json();
		//console.log("workIds:", workIdList.value);
	});


	const iconForFile = file => {
		switch (file.ext) {
		case "pdf":
			return String.fromCodePoint(0x1f3bc);

		case "mp3":
		case "ogg":
		case "flac":
			return String.fromCodePoint(0x1f3b5);

		case "mid":
			return String.fromCodePoint(0x1f3b9);
		}

		return "";
	};


	watch(workId, async value => {
		//console.log("workId:", value);
		const response = await fetch(`/work-basic?id=${value}`);
		workInfo.value = await response.json();
	});
</script>
